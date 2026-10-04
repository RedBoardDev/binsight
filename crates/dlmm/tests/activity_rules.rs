//! The lifecycle, liquidity, swap and unknown-event rules of `position_activity`, on synthetic
//! scenarios of the exact shapes the program emits (decoder oracle D-1, corrections X-6, X-8 and
//! X-9).

mod common;

use binsight_dlmm::activity::{ActivityError, LifecycleFact, MovementKind};
use binsight_solana::transaction::InstructionPosition;
use common::scenarios::{activity_of, movement_summary};
use common::{address, at, swap};

#[test]
fn books_an_add_liquidity_as_one_deposit_with_exact_amounts() {
    assert_eq!(
        movement_summary("add-liquidity"),
        [(
            MovementKind::Deposit,
            205_945_537_665,
            3_376_692_725,
            Some(-437)
        )]
    );
    let movement = activity_of("add-liquidity").unwrap().movements[0];
    assert_eq!((movement.pool, movement.position), (address(1), address(2)));
}

#[test]
fn keeps_a_zero_deposit_so_that_an_empty_shell_can_be_told() {
    assert_eq!(
        movement_summary("zero-deposit"),
        [(MovementKind::Deposit, 0, 0, Some(-12))]
    );
}

#[test]
fn reads_the_owner_from_position_create() {
    assert_eq!(
        activity_of("position-create").unwrap().lifecycle,
        [LifecycleFact::Created {
            at: at(0, 0),
            position: address(2),
            pool: address(1),
            owner: address(100),
        }]
    );
}

#[test]
fn produces_no_activity_for_a_failed_transaction() {
    assert_eq!(
        activity_of("failed-transaction"),
        Ok(binsight_dlmm::TxActivity::default())
    );
}

#[test]
fn flags_a_close_instruction_without_a_close_event() {
    assert_eq!(
        activity_of("close-without-event"),
        Err(ActivityError::CloseWithoutEvent {
            position: address(2),
            at: InstructionPosition {
                top: 3,
                inner: None
            },
        })
    );
}

#[test]
fn accepts_a_close_if_empty_that_found_the_position_not_empty() {
    assert_eq!(
        activity_of("close-if-empty-not-empty").unwrap().lifecycle,
        []
    );
}

#[test]
fn closes_a_position_whose_close_event_is_there() {
    assert_eq!(
        activity_of("close-with-event").unwrap().lifecycle,
        [LifecycleFact::Closed {
            at: at(0, 0),
            position: address(2),
            owner: address(100),
        }]
    );
}

#[test]
fn keeps_a_position_closed_and_recreated_at_the_same_address_in_order() {
    assert_eq!(
        activity_of("close-and-recreate").unwrap().lifecycle,
        [
            LifecycleFact::Closed {
                at: at(0, 0),
                position: address(2),
                owner: address(100),
            },
            LifecycleFact::Created {
                at: at(1, 0),
                position: address(2),
                pool: address(1),
                owner: address(100),
            },
        ]
    );
}

#[test]
fn flags_a_funded_position_created_without_a_create_event() {
    assert_eq!(
        activity_of("open-without-event"),
        Err(ActivityError::OpenWithoutEvent {
            position: address(2),
            at: InstructionPosition {
                top: 2,
                inner: None
            },
        })
    );
}

#[test]
fn keeps_a_swap_through_a_pool_as_a_pool_swap_and_no_movement() {
    let activity = activity_of("swap-second-form-only").unwrap();
    assert_eq!(activity.movements, []);
    assert_eq!(activity.pool_swaps.len(), 1);
    assert_eq!(activity.pool_swaps[0].pool, address(1));
    assert_eq!(activity.pool_swaps[0].swap, swap());
}

#[test]
fn counts_a_swap_reported_by_both_swap_events_once() {
    let swaps = activity_of("swap-both-forms-one-call").unwrap().pool_swaps;
    assert_eq!(swaps.len(), 1);
    assert_eq!(swaps[0].at, at(1, 1));
}

#[test]
fn says_when_the_program_did_something_unknown() {
    let activity = activity_of("unknown-event").unwrap();
    assert!(activity.has_unknown_program_activity);
    assert!(
        !activity_of("add-liquidity")
            .unwrap()
            .has_unknown_program_activity
    );
}
