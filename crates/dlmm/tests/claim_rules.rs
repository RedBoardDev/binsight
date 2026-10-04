//! How `position_activity` counts fee and reward claims, on synthetic scenarios of the exact
//! shapes the program emits (decoder oracles D-2 to D-6, corrections X-5 and X-11).

mod common;

use binsight_dlmm::activity::MovementKind;
use common::scenarios::{activity_of, movement_summary};
use common::{address, at};

#[test]
fn counts_a_claim_once_when_claim_fee_and_claim_fee2_are_both_emitted() {
    assert_eq!(
        movement_summary("claim-both-forms-after-remove"),
        [
            (MovementKind::Withdrawal, 0, 9, Some(-429)),
            (MovementKind::FeeClaim, 0, 46_620_648, Some(-437)),
        ]
    );
    let claim = activity_of("claim-both-forms-after-remove")
        .unwrap()
        .movements[1];
    assert_eq!(claim.at, at(1, 1));
}

#[test]
fn keeps_v1_claims_without_a_v2_twin_in_a_batch() {
    assert_eq!(
        movement_summary("claim-batch-without-twins"),
        [
            (MovementKind::FeeClaim, 0, 100, Some(-5)),
            (MovementKind::FeeClaim, 0, 250, Some(-5)),
        ]
    );
}

#[test]
fn counts_a_claim_emitted_twice_once() {
    assert_eq!(
        movement_summary("claim-emitted-twice"),
        [(MovementKind::FeeClaim, 7, 8, Some(3))]
    );
}

#[test]
fn borrows_the_bin_of_an_event_of_the_same_pool_for_a_claim_without_one() {
    assert_eq!(
        movement_summary("claim-borrows-pool-bin")[1],
        (MovementKind::FeeClaim, 0, 5, Some(-429))
    );
}

#[test]
fn keeps_a_lone_claim_fee_v1_without_a_price_bin() {
    assert_eq!(
        movement_summary("claim-alone-without-bin"),
        [(MovementKind::FeeClaim, 896_784_000, 112_397_677, None)]
    );
}

#[test]
fn borrows_a_bin_only_from_an_event_of_the_same_pool() {
    assert_eq!(
        movement_summary("claim-other-pool-bin")[1],
        (MovementKind::FeeClaim, 0, 5, None)
    );
}

#[test]
fn counts_equal_claims_paid_by_two_instructions_twice() {
    assert_eq!(
        movement_summary("claim-equal-amounts-two-calls"),
        [
            (MovementKind::FeeClaim, 0, 29_075, Some(-7)),
            (MovementKind::FeeClaim, 0, 29_075, Some(-7)),
        ]
    );
    let movements = activity_of("claim-equal-amounts-two-calls")
        .unwrap()
        .movements;
    assert_eq!((movements[0].at, movements[1].at), (at(0, 1), at(1, 1)));
}

#[test]
fn counts_the_two_forms_emitted_by_one_instruction_once() {
    assert_eq!(
        movement_summary("claim-both-forms-one-call"),
        [(MovementKind::FeeClaim, 5, 6, Some(-7))]
    );
}

#[test]
fn names_the_reward_mint_from_the_instruction_that_paid_it() {
    let claims = activity_of("reward-mint-from-instruction")
        .unwrap()
        .reward_claims;
    let summary: Vec<_> = claims
        .iter()
        .map(|claim| (claim.reward_index, claim.amount.0, claim.mint))
        .collect();
    assert_eq!(summary, [(0, 1_000, Some(address(60)))]);
}
