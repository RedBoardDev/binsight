//! The claim, reward, limit order and close shapes, on real mainnet transactions of public
//! wallets.

mod common;

use binsight_dlmm::activity::{LifecycleFact, MovementKind};
use binsight_dlmm::event::DlmmEvent;
use common::{decoded_fixture, kinds_of, movements_of, parse_address, rewards_of};

#[test]
fn keeps_a_lone_first_form_claim_and_its_reward_without_a_bin() {
    assert_eq!(
        movements_of("claim-fee-v1-alone"),
        [(MovementKind::FeeClaim, 53_922, 625, None)]
    );
    let mint = parse_address("AuQaustGiaqxRvj2gtCdrd22PBzTn8kM3kEPEkZCtuDw");
    assert_eq!(
        rewards_of("claim-fee-v1-alone"),
        [(0, 133_562_321, Some(mint))]
    );
}

#[test]
fn counts_each_claim_fee2_call_once_over_its_two_forms() {
    assert_eq!(
        movements_of("claim-fee2-two-ranges"),
        [
            (MovementKind::FeeClaim, 0, 0, Some(-367)),
            (MovementKind::FeeClaim, 0, 29_075, Some(-367)),
        ]
    );
}

#[test]
fn names_the_mint_of_a_claimed_farming_reward() {
    let mint = parse_address("StepAscQoEioFxxWGnh2sLBDFp9d8rvKz2Yp39iDpyT");
    assert_eq!(rewards_of("claim-reward"), [(0, 29_529_988, Some(mint))]);
}

#[test]
fn leaves_open_a_position_that_close_if_empty_found_not_empty() {
    let (_, activity) = decoded_fixture("close-if-empty-not-empty");
    assert_eq!(activity.lifecycle, []);
    assert_eq!(
        movements_of("close-if-empty-not-empty"),
        [
            (MovementKind::Withdrawal, 0, 364_307_895, Some(-383)),
            (MovementKind::FeeClaim, 0, 0, Some(-383)),
        ]
    );
}

#[test]
fn decodes_a_cancelled_a_closed_and_a_placed_limit_order() {
    let (events, activity) = decoded_fixture("limit-order");
    let kinds: Vec<_> = events.iter().map(|located| located.event).collect();
    let [
        DlmmEvent::CancelLimitOrder(cancelled),
        DlmmEvent::CloseLimitOrder(closed),
        DlmmEvent::PlaceLimitOrder(placed),
    ] = kinds[..]
    else {
        panic!("not the three limit order events: {events:?}");
    };
    assert_eq!(
        (cancelled.amount_x.0, cancelled.amount_y.0),
        (2_064_979_638, 0)
    );
    assert_eq!(closed.limit_order, cancelled.limit_order);
    assert!(placed.is_ask_side);
    assert_eq!(placed.total_amount.0, 970_089_652);
    assert_eq!(activity, binsight_dlmm::TxActivity::default());
}

#[test]
fn books_a_claim_then_a_rebalance_then_the_close_of_one_position() {
    assert_eq!(
        movements_of("rebalance-and-claim-fee2"),
        [
            (MovementKind::FeeClaim, 0, 0, Some(-367)),
            (
                MovementKind::RebalanceWithdrawal,
                0,
                999_388_834,
                Some(-367)
            ),
        ]
    );
    let (_, activity) = decoded_fixture("rebalance-and-claim-fee2");
    assert!(matches!(
        activity.lifecycle.as_slice(),
        [LifecycleFact::Closed { .. }]
    ));
}

#[test]
fn a_close_whose_transaction_failed_closes_nothing() {
    assert_eq!(
        kinds_of("failed-close"),
        [
            "claim_fee",
            "claim_fee2",
            "remove_liquidity",
            "position_close"
        ]
    );
    let (_, activity) = decoded_fixture("failed-close");
    assert_eq!(activity, binsight_dlmm::TxActivity::default());
}

#[test]
fn counts_a_routed_swap_reported_by_both_swap_events_once() {
    assert_eq!(kinds_of("swap-through-dlmm"), ["swap", "swap2"]);
    let (events, activity) = decoded_fixture("swap-through-dlmm");
    assert_eq!(activity.movements, []);
    assert_eq!(activity.pool_swaps.len(), 1);
    assert_eq!(activity.pool_swaps[0].at, events[1].at);
    assert_eq!(activity.pool_swaps[0].swap.amount_in.0, 2_179_121_930);
}

#[test]
fn reads_a_close_from_the_first_weeks_of_the_program() {
    assert_eq!(
        kinds_of("early-close"),
        ["remove_liquidity", "claim_fee", "position_close"]
    );
    assert_eq!(
        movements_of("early-close"),
        [
            (MovementKind::Withdrawal, 0, 804_642_927, Some(-1_831)),
            (
                MovementKind::FeeClaim,
                17_532_198_246,
                3_524_425,
                Some(-1_831)
            ),
        ]
    );
    let (_, activity) = decoded_fixture("early-close");
    assert!(matches!(
        activity.lifecycle.as_slice(),
        [LifecycleFact::Closed { .. }]
    ));
}
