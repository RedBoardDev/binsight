//! A position row the fold cannot apply is refused alone: the transaction's entries and its other
//! rows still count, and the row's life is marked as missing activity.
#[path = "common/fold.rs"]
mod common;

use binsight_dlmm::activity::{LifecycleFact, MovementKind};
use binsight_ledger::book::EntryKind;
use binsight_ledger::facts::{PositionHistory, QuoteUnits};
use binsight_ledger::positions::{FoldError, PositionRefusal};
use binsight_ledger::report::closed::Outcome;
use common::*;

fn refusal(position: binsight_solana::Address, error: FoldError) -> PositionRefusal {
    PositionRefusal { position, error }
}

#[test]
fn refuses_a_creation_without_a_block_time_alone() {
    let mut fold = fold();
    let activity = lifecycle(vec![created(POSITION, SOL_POOL, WALLET)]);
    let mut tx = step(1, 1, &activity);
    tx.block_time = None;
    let folded = fold.book(&tx, &activity, &pools()).unwrap();
    assert_eq!(
        folded.refused,
        [refusal(
            POSITION,
            FoldError::MissingBlockTime {
                signature: tx.signature
            }
        )]
    );
    assert!(
        folded
            .entries
            .iter()
            .any(|entry| entry.kind == EntryKind::NetworkFee)
    );
    assert_eq!(fold.open().count(), 0);
    assert_eq!(fold.diagnostics().refused_rows, 1);
}

/// The pool of a 500-lamport withdrawal has no facts: the withdrawal is refused, its entry is
/// still booked, and the life is marked as missing what it did.
#[test]
fn keeps_the_entries_of_a_movement_whose_pool_has_no_facts() {
    let mut fold = fold();
    run(
        &mut fold,
        &[lifecycle(vec![created(POSITION, SOL_POOL, WALLET)])],
    );
    let withdrawal = moves(vec![movement(
        POSITION,
        SOL_POOL,
        MovementKind::Withdrawal,
        (0, 500),
        Some(0),
    )]);
    let mut pools = pools();
    pools.remove(&SOL_POOL);
    let folded = fold
        .book(&step(2, 2, &withdrawal), &withdrawal, &pools)
        .unwrap();
    assert_eq!(
        folded.refused,
        [refusal(POSITION, FoldError::MissingPool { pool: SOL_POOL })]
    );
    assert!(folded.entries.iter().any(|entry| entry.kind
        == EntryKind::PositionWithdrawal { position: POSITION }
        && entry.amount == 500));
    let life = fold.open().next().unwrap();
    assert_eq!(life.flows.withdrawn, QuoteUnits(0));
    assert_eq!(life.history, PositionHistory::UncountedActivity);
}

/// One transaction closes a life and creates the same account twice: the second life would carry
/// the first one's identity, so its creation is refused.
#[test]
fn refuses_a_second_life_with_the_identity_of_one_closed_in_the_same_transaction() {
    let mut fold = fold();
    let lifecycle_at = |top, fact: LifecycleFact| match fact {
        LifecycleFact::Created {
            position,
            pool,
            owner,
            ..
        } => LifecycleFact::Created {
            at: at(top),
            position,
            pool,
            owner,
        },
        LifecycleFact::Closed {
            position, owner, ..
        } => LifecycleFact::Closed {
            at: at(top),
            position,
            owner,
        },
    };
    let twice = lifecycle(vec![
        lifecycle_at(0, created(POSITION, SOL_POOL, WALLET)),
        lifecycle_at(1, closed(POSITION, WALLET)),
        lifecycle_at(2, created(POSITION, SOL_POOL, WALLET)),
    ]);
    let folded = fold.book(&step(1, 1, &twice), &twice, &pools()).unwrap();
    assert_eq!(folded.closed.len(), 1);
    assert_eq!(
        folded.refused,
        [refusal(
            POSITION,
            FoldError::IdentityCollision { position: POSITION }
        )]
    );
    assert_eq!(fold.open().count(), 0);

    // A deposit after the second creation would start a life without a creation, with that
    // same identity: it is refused too.
    let mut deposit = movement(POSITION, SOL_POOL, MovementKind::Deposit, (0, 500), Some(0));
    deposit.at = at(3);
    let mut moved = twice.clone();
    moved.movements.push(deposit);
    let folded = fold.book(&step(2, 2, &moved), &moved, &pools()).unwrap();
    assert_eq!(
        folded.refused,
        [
            refusal(
                POSITION,
                FoldError::IdentityCollision { position: POSITION }
            ),
            refusal(
                POSITION,
                FoldError::IdentityCollision { position: POSITION }
            ),
        ]
    );
    assert_eq!(fold.open().count(), 0);
}

/// A close of the wallet's open life names another owner: the account is gone, so the life ends,
/// marked as missing what the other owner did.
#[test]
fn ends_the_wallets_life_at_a_close_that_names_another_owner() {
    let mut fold = fold();
    let closed = run(
        &mut fold,
        &[
            lifecycle(vec![created(POSITION, SOL_POOL, WALLET)]),
            lifecycle(vec![closed(POSITION, OTHER_OWNER)]),
        ],
    );
    assert_eq!(closed.len(), 1);
    assert_eq!(closed[0].history, PositionHistory::UncountedActivity);
    assert_eq!(valued(&closed[0]).outcome, Outcome::Unknown);
    assert_eq!(fold.open().count(), 0);
}

#[test]
fn refuses_a_creation_of_a_life_that_is_still_open_alone() {
    let mut fold = fold();
    run(
        &mut fold,
        &[lifecycle(vec![created(POSITION, SOL_POOL, WALLET)])],
    );
    let again = lifecycle(vec![created(POSITION, SOL_POOL, WALLET)]);
    let folded = fold.book(&step(2, 2, &again), &again, &pools()).unwrap();
    assert_eq!(
        folded.refused,
        [refusal(
            POSITION,
            FoldError::CreatedWhileOpen { position: POSITION }
        )]
    );
    let lives: Vec<_> = fold.open().collect();
    assert_eq!(lives.len(), 1);
    assert_eq!(lives[0].id.opened_by, transaction(1, 1).signature);
    assert_eq!(lives[0].history, PositionHistory::UncountedActivity);
}
