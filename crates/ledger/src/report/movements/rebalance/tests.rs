//! Synthetic rebalance contributions never net or spread uncertainty across lifetime boundaries.

use binsight_core::units::RawTokenAmount;
use binsight_solana::Address;
use jiff::Timestamp;

use super::*;
use crate::facts::{ChainOrder, PositionId, RebalanceFlow, TokenFlow};

fn life(address: u8, creation: u8) -> PositionId {
    PositionId {
        address: Address::from_bytes([address; 32]),
        opened_by: Signature::from_bytes([creation; 64]),
    }
}

fn flow(amount: i128) -> RebalanceFlow {
    RebalanceFlow {
        instruction: InstructionPosition {
            top: 0,
            inner: Some(3),
        },
        flow: TokenFlow {
            base: RawTokenAmount(5),
            quote: RawTokenAmount(7),
            value: QuoteUnits(amount),
            valuation: FlowValuation::Complete,
        },
    }
}

fn event(position: PositionId, kind: PositionEventKind) -> PositionEventFact {
    PositionEventFact {
        position,
        at: Timestamp::UNIX_EPOCH,
        order: ChainOrder {
            slot: 1,
            transaction_index: 0,
            event_index: 0,
        },
        signature: Signature::from_bytes([99; 64]),
        active_bin_id: Some(0),
        kind,
    }
}

fn deposit(position: PositionId, amount: i128) -> PositionEventFact {
    event(
        position,
        PositionEventKind::RebalanceDeposit {
            movement: flow(amount),
            range: None,
        },
    )
}

fn withdrawal(position: PositionId, amount: i128) -> PositionEventFact {
    event(
        position,
        PositionEventKind::RebalanceWithdrawal(flow(amount)),
    )
}

fn values(events: &[PositionEventFact]) -> Vec<QuoteUnits> {
    contributions(events)
        .unwrap()
        .into_iter()
        .map(|item| item.value)
        .collect()
}

#[test]
fn keeps_opposite_contributions_separate_for_two_positions_in_the_same_instruction() {
    let first = life(11, 1);
    let second = life(12, 2);
    let events = [
        withdrawal(first, 100),
        deposit(first, 110),
        withdrawal(second, 110),
        deposit(second, 100),
    ];
    assert_eq!(
        values(&events),
        [QuoteUnits(0), QuoteUnits(10), QuoteUnits(10), QuoteUnits(0)]
    );
}

#[test]
fn keys_the_complete_lifetime_id_instead_of_only_the_reused_account_address() {
    // This helper-level input tests ID separation, not whether replay permits both lives at one at.
    let first = life(11, 1);
    let second = life(11, 2);
    let events = [
        withdrawal(first, 100),
        deposit(first, 110),
        withdrawal(second, 110),
        deposit(second, 100),
    ];
    assert_eq!(
        values(&events),
        [QuoteUnits(0), QuoteUnits(10), QuoteUnits(10), QuoteUnits(0)]
    );
}

#[test]
fn confines_unknown_rebalance_valuation_to_its_own_position_group() {
    let first = life(11, 1);
    let second = life(12, 2);
    let mut unknown = withdrawal(first, 100);
    if let PositionEventKind::RebalanceWithdrawal(movement) = &mut unknown.kind {
        movement.flow.valuation = FlowValuation::QuoteOnly;
    }
    let events = [
        unknown,
        deposit(first, 110),
        withdrawal(second, 70),
        deposit(second, 90),
    ];
    let coverage: Vec<_> = contributions(&events)
        .unwrap()
        .into_iter()
        .map(|item| item.valuation)
        .collect();
    assert_eq!(
        coverage,
        [
            FlowValuation::QuoteOnly,
            FlowValuation::QuoteOnly,
            FlowValuation::Complete,
            FlowValuation::Complete
        ]
    );
}

#[test]
fn avoids_artificial_overflow_when_two_independent_groups_each_fit() {
    let first = life(11, 1);
    let second = life(12, 2);
    let events = [
        withdrawal(first, i128::MAX),
        deposit(first, i128::MAX),
        withdrawal(second, i128::MAX),
        deposit(second, i128::MAX),
    ];
    assert_eq!(values(&events), [QuoteUnits(0); 4]);
}

#[test]
fn still_rejects_an_overflow_inside_one_lifetime_group() {
    let position = life(11, 1);
    let events = [
        withdrawal(position, i128::MAX),
        deposit(position, i128::MAX),
        deposit(position, 1),
    ];
    assert!(matches!(contributions(&events), Err(AmountError::Overflow)));
}

#[test]
fn assigns_each_net_only_once_without_combining_other_instructions_or_transactions() {
    let position = life(11, 1);
    let mut next_instruction = withdrawal(position, 10);
    if let PositionEventKind::RebalanceWithdrawal(movement) = &mut next_instruction.kind {
        movement.instruction.top = 1;
    }
    let mut next_transaction = deposit(position, 13);
    next_transaction.signature = Signature::from_bytes([98; 64]);
    let events = [
        withdrawal(position, 100),
        deposit(position, 106),
        deposit(position, 4),
        next_instruction,
        next_transaction,
    ];
    assert_eq!(
        values(&events),
        [
            QuoteUnits(0),
            QuoteUnits(10),
            QuoteUnits(0),
            QuoteUnits(10),
            QuoteUnits(13)
        ]
    );
}
