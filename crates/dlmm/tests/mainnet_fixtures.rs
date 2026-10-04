//! Decoding and normalising real mainnet transactions of public wallets.

mod common;

use binsight_dlmm::activity::{LifecycleFact, MovementKind, position_activity};
use binsight_dlmm::event::{DlmmEvent, decode_events};
use binsight_dlmm::instruction::{InstructionKind, classify};
use binsight_solana::transaction::TxOutcome;
use common::{decoded_fixture, every_fixture, fixture, kinds_of, movements_of, parse_address};

#[test]
fn decodes_every_fixture_without_an_unknown_event_or_instruction() {
    for (label, tx) in every_fixture() {
        let events = decode_events(&tx).unwrap_or_else(|error| panic!("{label}: {error}"));
        for located in &events {
            assert!(
                !matches!(located.event, DlmmEvent::Unknown { .. }),
                "{label}: {located:?}"
            );
        }
        for instruction in &tx.instructions {
            assert_ne!(
                classify(instruction),
                Some(InstructionKind::Unknown),
                "{label}"
            );
        }
        let activity =
            position_activity(&tx, &events).unwrap_or_else(|error| panic!("{label}: {error}"));
        assert!(!activity.has_unknown_program_activity, "{label}");
    }
}

#[test]
fn closing_a_position_counts_its_claim_once_at_the_bin_of_claim_fee2() {
    let case = "claim-fee2-with-claim-fee";
    assert_eq!(
        kinds_of(case),
        [
            "remove_liquidity",
            "claim_fee",
            "claim_fee2",
            "position_close"
        ]
    );
    assert_eq!(
        movements_of(case),
        [
            (MovementKind::Withdrawal, 0, 2_100_280_970, Some(-509)),
            (MovementKind::FeeClaim, 203_206_129, 1_086_825, Some(-509)),
        ]
    );
    let (_, activity) = decoded_fixture(case);
    let position = parse_address("2yVmeEM1xUEr575N8pkCTmBrgBVq3yLRcKLNdHzH3VJY");
    assert!(matches!(
        activity.lifecycle.as_slice(),
        [LifecycleFact::Closed { position: closed, owner, .. }]
            if *closed == position
                && *owner == parse_address("5TUvWjeid81ivRQTWSQ6ibfst4x6XGinMWW3J4EkGoug")
    ));
}

#[test]
fn books_a_real_rebalance_as_withdrawal_deposit_and_harvested_fees() {
    assert_eq!(
        kinds_of("rebalance-with-fees"),
        ["composition_fee", "rebalancing"]
    );
    assert_eq!(
        movements_of("rebalance-with-fees"),
        [
            (
                MovementKind::RebalanceWithdrawal,
                1_810_254_944,
                514_681_472,
                Some(-427)
            ),
            (
                MovementKind::RebalanceDeposit,
                1_879_912_569,
                515_219_265,
                Some(-427)
            ),
            (MovementKind::FeeClaim, 69_660_673, 538_820, Some(-427)),
        ]
    );
}

#[test]
fn a_failed_swap_keeps_its_events_but_did_nothing() {
    assert_eq!(kinds_of("failed-swap-through-dlmm"), ["swap", "swap2"]);
    let (_, activity) = decoded_fixture("failed-swap-through-dlmm");
    assert_eq!(activity, binsight_dlmm::TxActivity::default());
}

#[test]
fn counts_a_swap_reported_by_both_swap_events_once() {
    let mut tx = fixture("failed-swap-through-dlmm", 0);
    tx.outcome = TxOutcome::Succeeded;
    let events = decode_events(&tx).unwrap();
    let swaps = position_activity(&tx, &events).unwrap().pool_swaps;
    assert_eq!(swaps.len(), 1);
    assert_eq!(swaps[0].at, events[1].at);
    assert_eq!(
        (swaps[0].swap.amount_in.0, swaps[0].swap.amount_out.0),
        (12_270_761, 101_028_549)
    );
}

#[test]
fn an_automation_claims_then_deposits_through_its_own_program() {
    assert_eq!(
        movements_of("v0-add-liquidity-alt"),
        [
            (MovementKind::FeeClaim, 298_632_811, 3_334_825, Some(-478)),
            (MovementKind::Deposit, 271_994_766, 3_068_052, Some(-478)),
        ]
    );
}
