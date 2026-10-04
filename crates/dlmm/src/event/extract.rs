//! Finding the DLMM events in a transaction and decoding each one.
//!
//! An event is an inner instruction to the DLMM program whose only account is the program's event
//! authority and whose data starts with the event tag. Anything else the program runs is an
//! instruction. This module walks the instructions once and
//! allocates only the list of events it returns.

use binsight_solana::MalformedBytes;
use binsight_solana::transaction::{InstructionNode, InstructionPosition, TransactionView};

use super::layout::read_fields;
use super::{DlmmEvent, EventName, LocatedEvent};
use crate::program::{EVENT_AUTHORITY, EVENT_IX_TAG, PROGRAM_ID};

/// A DLMM event that could not be decoded.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum DecodeError {
    /// The event ends before its 8-byte discriminator.
    #[error("the event at {at:?} ends before its discriminator")]
    MissingDiscriminator {
        /// Where the event is.
        at: InstructionPosition,
    },
    /// A known event whose fields are cut short or invalid.
    #[error("the {name} event at {at:?} is malformed")]
    MalformedEvent {
        /// Which event.
        name: EventName,
        /// Where it is.
        at: InstructionPosition,
        /// What could not be read.
        #[source]
        source: MalformedBytes,
    },
}

/// Decodes every event the DLMM program emitted in `tx`, in the order it emitted them.
///
/// The events of a failed transaction are decoded too, as the node recorded them, but they
/// changed nothing on chain: whoever stores them must keep the transaction's outcome beside
/// them, so that no reader takes a `PositionClose` of a failed transaction for a close.
///
/// # Errors
///
/// Returns a [`DecodeError`] when an event is too short for its discriminator, or when a known
/// event is too short for the fields binsight reads.
pub fn decode_events(tx: &TransactionView) -> Result<Vec<LocatedEvent>, DecodeError> {
    tx.instructions
        .iter()
        .filter_map(event_bytes)
        .map(|(at, bytes)| decode_event(at, bytes))
        .collect()
}

/// The bytes after the event tag, when `instruction` is a DLMM event.
fn event_bytes(instruction: &InstructionNode) -> Option<(InstructionPosition, &[u8])> {
    let is_event_call = instruction.program == PROGRAM_ID
        && instruction.position.inner.is_some()
        && instruction.accounts.first() == Some(&EVENT_AUTHORITY);
    if !is_event_call {
        return None;
    }
    let bytes = instruction.data.as_bytes().strip_prefix(&EVENT_IX_TAG)?;
    Some((instruction.position, bytes))
}

fn decode_event(at: InstructionPosition, bytes: &[u8]) -> Result<LocatedEvent, DecodeError> {
    let (discriminator, fields) = bytes
        .split_first_chunk::<8>()
        .ok_or(DecodeError::MissingDiscriminator { at })?;
    let event =
        match EventName::from_discriminator(*discriminator) {
            None => DlmmEvent::Unknown {
                discriminator: *discriminator,
            },
            Some(name) => read_fields(name, fields)
                .map_err(|source| DecodeError::MalformedEvent { name, at, source })?,
        };
    Ok(LocatedEvent { at, event })
}

#[cfg(test)]
mod tests {
    use binsight_core::units::RawTokenAmount;
    use binsight_solana::Address;

    use super::*;
    use crate::test_events::{EventBytes, event_instruction, transaction_with};

    fn address(byte: u8) -> Address {
        Address::from_bytes([byte; 32])
    }

    fn add_liquidity_bytes() -> EventBytes {
        EventBytes::new(EventName::AddLiquidity)
            .address(address(1))
            .address(address(2))
            .address(address(3))
            .u64(205_945_537_665)
            .u64(3_376_692_725)
            .i32(-437)
    }

    fn decode_one(bytes: &EventBytes) -> Result<DlmmEvent, DecodeError> {
        let tx = transaction_with(vec![event_instruction(0, 1, bytes.to_vec())]);
        decode_events(&tx).map(|events| events[0].event)
    }

    #[test]
    fn decodes_an_add_liquidity_event_with_exact_amounts() {
        let event = decode_one(&add_liquidity_bytes()).unwrap();
        let DlmmEvent::AddLiquidity(change) = event else {
            panic!("not an AddLiquidity: {event:?}");
        };
        assert_eq!(change.lb_pair, address(1));
        assert_eq!(change.from, address(2));
        assert_eq!(change.position, address(3));
        assert_eq!(change.amount_x, RawTokenAmount(205_945_537_665));
        assert_eq!(change.amount_y, RawTokenAmount(3_376_692_725));
        assert_eq!(change.active_bin_id, -437);
    }

    #[test]
    fn decodes_an_event_with_trailing_bytes_added_by_a_newer_program() {
        let longer = add_liquidity_bytes().u64(99).u8(1);
        assert_eq!(decode_one(&longer), decode_one(&add_liquidity_bytes()));
    }

    #[test]
    fn keeps_an_unknown_event_as_unknown_without_failing() {
        let mut bytes = EVENT_IX_TAG.to_vec();
        bytes.extend_from_slice(&[7; 8]);
        bytes.extend_from_slice(&[1, 2, 3]);
        let tx = transaction_with(vec![event_instruction(0, 1, bytes)]);
        let events = decode_events(&tx).unwrap();
        assert_eq!(
            events[0].event,
            DlmmEvent::Unknown {
                discriminator: [7; 8]
            }
        );
        assert_eq!(events[0].event.kind(), "unknown");
    }

    #[test]
    fn refuses_a_known_event_cut_before_a_field_it_needs() {
        let mut bytes = add_liquidity_bytes().to_vec();
        bytes.truncate(bytes.len() - 2);
        let tx = transaction_with(vec![event_instruction(2, 5, bytes)]);
        let error = decode_events(&tx).unwrap_err();
        assert!(matches!(
            error,
            DecodeError::MalformedEvent {
                name: EventName::AddLiquidity,
                at: InstructionPosition {
                    top: 2,
                    inner: Some(5)
                },
                source: MalformedBytes::UnexpectedEnd { .. },
            }
        ));
    }

    #[test]
    fn refuses_an_event_shorter_than_its_discriminator() {
        let mut bytes = EVENT_IX_TAG.to_vec();
        bytes.extend_from_slice(&[1, 2, 3]);
        let tx = transaction_with(vec![event_instruction(0, 0, bytes)]);
        assert!(matches!(
            decode_events(&tx),
            Err(DecodeError::MissingDiscriminator { .. })
        ));
    }

    #[test]
    fn ignores_tagged_data_that_is_not_an_event_call() {
        let top_level = InstructionNode {
            position: InstructionPosition {
                top: 0,
                inner: None,
            },
            ..event_instruction(0, 0, add_liquidity_bytes().to_vec())
        };
        let without_authority = InstructionNode {
            accounts: vec![address(9)],
            ..event_instruction(1, 0, add_liquidity_bytes().to_vec())
        };
        let other_program = InstructionNode {
            program: address(9),
            ..event_instruction(2, 0, add_liquidity_bytes().to_vec())
        };
        let tx = transaction_with(vec![top_level, without_authority, other_program]);
        assert_eq!(decode_events(&tx), Ok(Vec::new()));
    }

    #[test]
    fn reads_both_forms_of_the_swap_event_alike() {
        let first = EventBytes::new(EventName::Swap)
            .address(address(1))
            .address(address(2))
            .i32(-10)
            .i32(-12)
            .u64(1_000)
            .u64(990)
            .u8(1);
        let second = EventBytes::new(EventName::Swap2)
            .address(address(1))
            .address(address(2))
            .i32(-10)
            .i32(-12)
            .u8(1)
            .u128(25)
            .u64(1_000)
            .u64(0)
            .u64(990);
        let (DlmmEvent::Swap(first), DlmmEvent::Swap2(second)) =
            (decode_one(&first).unwrap(), decode_one(&second).unwrap())
        else {
            panic!("not two swaps");
        };
        assert_eq!(first, second);
        assert_eq!(first.amount_out, RawTokenAmount(990));
        assert!(first.swap_for_y);
    }

    #[test]
    fn sums_the_bins_of_a_placed_limit_order() {
        let bytes = EventBytes::new(EventName::PlaceLimitOrder)
            .address(address(1))
            .address(address(2))
            .address(address(3))
            .address(address(4))
            .i32(-5)
            .u8(1)
            .bytes(&[0; 16])
            .u8(1)
            .i32(-5)
            .i32(3)
            .u32(2)
            .i32(-4)
            .u64(u64::MAX)
            .i32(-3)
            .u64(2);
        let DlmmEvent::PlaceLimitOrder(order) = decode_one(&bytes).unwrap() else {
            panic!("not a limit order");
        };
        assert!(order.is_ask_side);
        assert_eq!(order.total_amount, RawTokenAmount(u128::from(u64::MAX) + 2));
    }

    #[test]
    fn names_a_known_event_it_does_not_model_without_reading_its_fields() {
        let bytes = EventBytes::new(EventName::LbPairCreate);
        assert_eq!(
            decode_one(&bytes),
            Ok(DlmmEvent::Unmodelled(EventName::LbPairCreate))
        );
    }
}
