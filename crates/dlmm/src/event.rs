//! The events the DLMM program emits, decoded from a transaction.
//!
//! The program logs each event as an inner instruction to itself (Anchor "event CPI"): the event
//! tag, an 8-byte discriminator naming the event, then its fields in Borsh. [`decode_events`]
//! finds those instructions in a [`TransactionView`](binsight_solana::transaction::TransactionView)
//! and returns a [`DlmmEvent`] for each, in execution order. Events are read from the
//! instructions, never from the logs, which nodes cut at 10 KB.
//!
//! Reading is **tolerant**: a newer program may append fields to an event, so only the leading
//! fields binsight needs are read and any bytes after them are ignored. An event whose
//! discriminator is unknown is kept as [`DlmmEvent::Unknown`] instead of failing the
//! transaction. This module decodes; deciding what the events mean for a position is the job of
//! [`crate::activity`].

mod contents;
mod extract;
mod layout;
mod name;
mod payload;

use binsight_solana::transaction::InstructionPosition;
use serde::Serialize;

pub use contents::{
    CompositionFeeCharged, FeeClaimed, LimitOrderCancelled, LimitOrderClosed, LimitOrderPlaced,
    LiquidityChanged, PositionClosed, PositionCreated, PositionLengthChanged, Rebalanced,
    RewardClaimed, Swapped,
};
pub use extract::{DecodeError, decode_events};
pub use name::EventName;

/// One event of the DLMM program.
///
/// The variants are named after the events of the program's IDL. Serialized (to JSON), an event
/// is the object of its fields, with amounts as decimal strings; its kind is stored apart (see
/// [`DlmmEvent::kind`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(untagged)]
pub enum DlmmEvent {
    /// A position created.
    PositionCreate(PositionCreated),
    /// A position closed.
    PositionClose(PositionClosed),
    /// Liquidity added to a position.
    AddLiquidity(LiquidityChanged),
    /// Liquidity removed from a position.
    RemoveLiquidity(LiquidityChanged),
    /// Liquidity moved inside a position.
    Rebalancing(Rebalanced),
    /// Swap fees paid to the owner of a position, in the first form, which has no bin.
    ClaimFee(FeeClaimed),
    /// Swap fees paid to the owner of a position, with the active bin.
    ClaimFee2 {
        /// The claim.
        #[serde(flatten)]
        claim: FeeClaimed,
        /// The active bin of the pool at that moment.
        active_bin_id: i32,
    },
    /// A farming reward paid to the owner of a position, in the first form, which has no bin.
    ClaimReward(RewardClaimed),
    /// A farming reward paid to the owner of a position, with the active bin.
    ClaimReward2 {
        /// The claim.
        #[serde(flatten)]
        claim: RewardClaimed,
        /// The active bin of the pool at that moment.
        active_bin_id: i32,
    },
    /// A swap against a pool, in the first form.
    Swap(Swapped),
    /// A swap against a pool, in the second form (`Swap2Evt`).
    Swap2(Swapped),
    /// A limit order placed.
    PlaceLimitOrder(LimitOrderPlaced),
    /// A limit order cancelled.
    CancelLimitOrder(LimitOrderCancelled),
    /// An empty limit order account closed.
    CloseLimitOrder(LimitOrderClosed),
    /// The fee charged on liquidity added to the active bin.
    CompositionFee(CompositionFeeCharged),
    /// A position made longer.
    IncreasePositionLength(PositionLengthChanged),
    /// A position made shorter.
    DecreasePositionLength(PositionLengthChanged),
    /// A known event whose fields binsight does not need (pool administration, rewards funding,
    /// operators): it is named, and its fields are not read.
    Unmodelled(#[serde(serialize_with = "payload::no_fields")] EventName),
    /// An event this version of binsight does not know, kept so that it can be counted.
    Unknown {
        /// The 8 bytes that name it.
        #[serde(serialize_with = "payload::discriminator")]
        discriminator: [u8; 8],
    },
}

impl DlmmEvent {
    /// The name of the event, `None` for an unknown one.
    pub fn name(&self) -> Option<EventName> {
        let name = match self {
            Self::PositionCreate(_) => EventName::PositionCreate,
            Self::PositionClose(_) => EventName::PositionClose,
            Self::AddLiquidity(_) => EventName::AddLiquidity,
            Self::RemoveLiquidity(_) => EventName::RemoveLiquidity,
            Self::Rebalancing(_) => EventName::Rebalancing,
            Self::ClaimFee(_) => EventName::ClaimFee,
            Self::ClaimFee2 { .. } => EventName::ClaimFee2,
            Self::ClaimReward(_) => EventName::ClaimReward,
            Self::ClaimReward2 { .. } => EventName::ClaimReward2,
            Self::Swap(_) => EventName::Swap,
            Self::Swap2(_) => EventName::Swap2,
            Self::PlaceLimitOrder(_) => EventName::PlaceLimitOrder,
            Self::CancelLimitOrder(_) => EventName::CancelLimitOrder,
            Self::CloseLimitOrder(_) => EventName::CloseLimitOrder,
            Self::CompositionFee(_) => EventName::CompositionFee,
            Self::IncreasePositionLength(_) => EventName::IncreasePositionLength,
            Self::DecreasePositionLength(_) => EventName::DecreasePositionLength,
            Self::Unmodelled(name) => *name,
            Self::Unknown { .. } => return None,
        };
        Some(name)
    }

    /// The kind binsight stores the event under, in snake case (`add_liquidity`), or `unknown`.
    pub fn kind(&self) -> &'static str {
        self.name().map_or(UNKNOWN_KIND, EventName::kind)
    }
}

/// The kind of an event whose discriminator is unknown.
const UNKNOWN_KIND: &str = "unknown";

/// An event and the place of the instruction that carried it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LocatedEvent {
    /// The inner instruction that carried the event; the order of positions is the order in
    /// which the events were emitted.
    pub at: InstructionPosition,
    /// The event.
    pub event: DlmmEvent,
}

#[cfg(test)]
mod tests {
    use binsight_core::units::RawTokenAmount;
    use binsight_solana::Address;

    use super::*;

    fn claim(fee_x: u128) -> FeeClaimed {
        FeeClaimed {
            lb_pair: Address::from_bytes([0; 32]),
            position: Address::from_bytes([0; 32]),
            owner: Address::from_bytes([0; 32]),
            fee_x: RawTokenAmount(fee_x),
            fee_y: RawTokenAmount(0),
        }
    }

    #[test]
    fn writes_amounts_as_decimal_strings_and_the_bin_beside_the_claim() {
        let event = DlmmEvent::ClaimFee2 {
            claim: claim(900_719_925_474_099_312_345),
            active_bin_id: -437,
        };
        let address = "11111111111111111111111111111111";
        assert_eq!(
            serde_json::to_string(&event).unwrap(),
            format!(
                "{{\"lb_pair\":\"{address}\",\"position\":\"{address}\",\"owner\":\"{address}\",\
                 \"fee_x\":\"900719925474099312345\",\"fee_y\":\"0\",\"active_bin_id\":-437}}"
            )
        );
        assert_eq!(event.kind(), "claim_fee2");
    }

    #[test]
    fn writes_an_unknown_event_as_its_discriminator_and_an_unmodelled_one_as_nothing() {
        let unknown = DlmmEvent::Unknown {
            discriminator: [0xe4, 0x45, 0, 1, 2, 3, 0xfe, 0xff],
        };
        assert_eq!(
            serde_json::to_string(&unknown).unwrap(),
            "{\"discriminator\":\"e44500010203feff\"}"
        );
        let unmodelled = DlmmEvent::Unmodelled(EventName::LbPairCreate);
        assert_eq!(serde_json::to_string(&unmodelled).unwrap(), "{}");
        assert_eq!(unmodelled.kind(), "lb_pair_create");
    }
}
