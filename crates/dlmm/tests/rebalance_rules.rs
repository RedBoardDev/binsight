//! How `position_activity` reads a rebalance and what it harvests, on synthetic scenarios
//! (decoder oracles D-7 and D-8).
//!
//! D-8 states one claim for a harvesting rebalance and a `ClaimFee2` of the same position and
//! amounts. A harvesting rebalance pays the position's fees and leaves none behind, so a
//! `claim_fee2` call afterwards pays fees earned since: when the emitting instructions are
//! known, they are two payments, counted apart. Only without stack heights, when the emitting
//! instruction cannot be told, do the two reports fall back to one claim.

mod common;

use binsight_dlmm::activity::MovementKind;
use binsight_solana::Address;
use common::scenarios::{activity_of, movement_summary};

#[test]
fn books_a_rebalance_as_withdrawal_deposit_and_harvested_fees() {
    assert_eq!(
        movement_summary("rebalance-harvest"),
        [
            (MovementKind::RebalanceWithdrawal, 5, 7, Some(-410)),
            (MovementKind::RebalanceDeposit, 4, 6, Some(-410)),
            (MovementKind::FeeClaim, 2, 3, Some(-410)),
        ]
    );
}

#[test]
fn counts_a_rebalance_harvest_and_a_later_claim_of_the_same_position_apart() {
    assert_eq!(
        movement_summary("rebalance-harvest-then-claim"),
        [
            (MovementKind::RebalanceDeposit, 0, 6, Some(-410)),
            (MovementKind::FeeClaim, 2, 3, Some(-410)),
            (MovementKind::FeeClaim, 2, 3, Some(-410)),
        ]
    );
}

#[test]
fn deduplicates_across_the_transaction_without_stack_heights() {
    assert_eq!(
        movement_summary("rebalance-and-claim-without-stack-heights"),
        [
            (MovementKind::RebalanceDeposit, 0, 6, Some(-410)),
            (MovementKind::FeeClaim, 2, 3, Some(-410)),
        ]
    );
}

#[test]
fn keeps_rebalance_fees_when_a_claim_of_the_same_position_reports_another_claim() {
    assert_eq!(
        movement_summary("rebalance-and-claim-of-other-amounts"),
        [
            (MovementKind::RebalanceDeposit, 0, 6, Some(-410)),
            (MovementKind::FeeClaim, 2, 3, Some(-410)),
            (MovementKind::FeeClaim, 0, 0, Some(-410)),
        ]
    );
}

#[test]
fn books_rewards_harvested_by_a_rebalance_unless_a_reward_claim_reports_them() {
    let activity = activity_of("rebalance-rewards").unwrap();
    let claims: Vec<_> = activity
        .reward_claims
        .iter()
        .map(|claim| (claim.reward_index, claim.amount.0, claim.mint))
        .collect();
    assert_eq!(claims, [(0, 11, None), (1, 22, None)]);
    assert_eq!(activity.movements, []);
}

#[test]
fn reads_the_mint_of_a_harvested_reward_from_the_transfer_that_paid_it() {
    let activity = activity_of("rebalance-rewards-with-transfers").unwrap();
    let claims: Vec<_> = activity
        .reward_claims
        .iter()
        .map(|claim| (claim.reward_index, claim.amount.0, claim.mint))
        .collect();
    assert_eq!(
        claims,
        [
            (0, 11, Some(Address::from_bytes([71; 32]))),
            (1, 22, Some(Address::from_bytes([81; 32]))),
        ]
    );
}
