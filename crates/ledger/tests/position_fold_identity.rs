//! Which lives the position fold opens, and the transactions it refuses without changing.
#[path = "common/fold.rs"]
mod common;

use binsight_dlmm::activity::MovementKind;
use binsight_ledger::positions::FoldError;
use common::*;

#[test]
fn ignores_the_movements_of_a_position_another_wallet_created() {
    let mut fold = fold();
    let closed = run(
        &mut fold,
        &[
            lifecycle(vec![created(POSITION, SOL_POOL, OTHER_OWNER)]),
            moves(vec![movement(
                POSITION,
                SOL_POOL,
                MovementKind::Withdrawal,
                (0, 500),
                Some(0),
            )]),
            lifecycle(vec![closed(POSITION, OTHER_OWNER)]),
        ],
    );
    assert_eq!(closed, []);
    assert_eq!(fold.open().count(), 0);
    assert_eq!(fold.diagnostics().missing_creations, 0);
}

/// A position account closed and created again is a new life with the new creating signature.
#[test]
fn treats_a_position_created_again_at_the_same_address_as_a_new_life() {
    let mut fold = fold();
    let closed = run(
        &mut fold,
        &[
            lifecycle(vec![created(POSITION, SOL_POOL, WALLET)]),
            lifecycle(vec![closed(POSITION, WALLET)]),
            lifecycle(vec![created(POSITION, SOL_POOL, WALLET)]),
        ],
    );
    let reopened: Vec<_> = fold.open().map(|life| life.id).collect();
    assert_eq!(closed.len(), 1);
    assert_eq!(reopened.len(), 1);
    assert_eq!(closed[0].id.address, reopened[0].address);
    assert_eq!(closed[0].id.opened_by, transaction(1, 1).signature);
    assert_eq!(reopened[0].opened_by, transaction(3, 3).signature);
}

#[test]
fn refuses_a_transaction_older_than_the_last_one_and_keeps_its_state() {
    let mut fold = fold();
    run(
        &mut fold,
        &[lifecycle(vec![]), lifecycle(vec![]), lifecycle(vec![])],
    );
    let before = fold.clone();
    let late = lifecycle(vec![created(POSITION, SOL_POOL, WALLET)]);
    let result = fold.book(&step(9, 2, &late), &late, &pools());
    assert_eq!(
        result,
        Err(FoldError::OutOfOrder {
            signature: transaction(9, 2).signature
        })
    );
    assert_eq!(fold, before);
}

#[test]
fn refuses_a_creation_without_a_block_time_and_keeps_its_state() {
    let mut fold = fold();
    let activity = lifecycle(vec![created(POSITION, SOL_POOL, WALLET)]);
    let mut tx = step(1, 1, &activity);
    tx.block_time = None;
    assert_eq!(
        fold.book(&tx, &activity, &pools()),
        Err(FoldError::MissingBlockTime {
            signature: tx.signature
        })
    );
    assert_eq!(fold, common::fold());
}

#[test]
fn refuses_a_movement_whose_pool_has_no_facts_and_keeps_its_state() {
    let mut fold = fold();
    run(
        &mut fold,
        &[lifecycle(vec![created(POSITION, SOL_POOL, WALLET)])],
    );
    let before = fold.clone();
    let withdrawal = moves(vec![movement(
        POSITION,
        SOL_POOL,
        MovementKind::Withdrawal,
        (0, 500),
        Some(0),
    )]);
    let tx = step(2, 2, &withdrawal);
    let mut pools = pools();
    pools.remove(&SOL_POOL);
    assert_eq!(
        fold.book(&tx, &withdrawal, &pools),
        Err(FoldError::MissingPool { pool: SOL_POOL })
    );
    assert_eq!(fold, before);
}

#[test]
fn refuses_a_transaction_without_its_index_in_the_block_and_keeps_its_state() {
    let mut fold = fold();
    run(&mut fold, &[lifecycle(vec![])]);
    let before = fold.clone();
    let activity = lifecycle(vec![created(POSITION, SOL_POOL, WALLET)]);
    let mut tx = step(2, 2, &activity);
    tx.transaction_index = None;
    assert_eq!(
        fold.book(&tx, &activity, &pools()),
        Err(FoldError::MissingTransactionIndex {
            signature: tx.signature
        })
    );
    assert_eq!(fold, before);
}

/// In one slot the index in the block decides: index 3, then 4, then a second index 4 or an
/// index 2 come too late.
#[test]
fn orders_the_transactions_of_one_slot_by_their_index_in_the_block() {
    let mut fold = fold();
    let empty = lifecycle(vec![]);
    let at_index = |seed, index| {
        let mut tx = step(seed, 5, &empty);
        tx.transaction_index = Some(index);
        tx
    };
    let pools = pools();
    assert!(fold.book(&at_index(1, 3), &empty, &pools).is_ok());
    assert!(fold.book(&at_index(2, 4), &empty, &pools).is_ok());
    for (seed, index) in [(3, 4), (4, 2)] {
        let late = at_index(seed, index);
        assert_eq!(
            fold.book(&late, &empty, &pools),
            Err(FoldError::OutOfOrder {
                signature: late.signature
            })
        );
    }
}

/// One transaction closes the wallet's position and creates the same account again: the new life
/// would carry the closed life's identity, so the transaction is refused.
#[test]
fn refuses_two_lives_with_one_identity_in_one_transaction() {
    use binsight_dlmm::activity::LifecycleFact;
    let mut fold = fold();
    run(
        &mut fold,
        &[lifecycle(vec![created(POSITION, SOL_POOL, WALLET)])],
    );
    let before = fold.clone();
    let again = lifecycle(vec![
        LifecycleFact::Created {
            at: at(0),
            position: POSITION,
            pool: SOL_POOL,
            owner: WALLET,
        },
        LifecycleFact::Closed {
            at: at(1),
            position: POSITION,
            owner: WALLET,
        },
        LifecycleFact::Created {
            at: at(2),
            position: POSITION,
            pool: SOL_POOL,
            owner: WALLET,
        },
    ]);
    // The first creation refuses already: the life opened in slot 1 is still open.
    assert_eq!(
        fold.book(&step(2, 2, &again), &again, &pools()),
        Err(FoldError::CreatedWhileOpen { position: POSITION })
    );
    let recreated = lifecycle(vec![
        LifecycleFact::Closed {
            at: at(0),
            position: POSITION,
            owner: WALLET,
        },
        LifecycleFact::Created {
            at: at(1),
            position: SECOND_POSITION,
            pool: SOL_POOL,
            owner: WALLET,
        },
        LifecycleFact::Closed {
            at: at(2),
            position: SECOND_POSITION,
            owner: WALLET,
        },
        LifecycleFact::Created {
            at: at(3),
            position: SECOND_POSITION,
            pool: SOL_POOL,
            owner: WALLET,
        },
    ]);
    assert_eq!(
        fold.book(&step(3, 3, &recreated), &recreated, &pools()),
        Err(FoldError::IdentityCollision {
            position: SECOND_POSITION
        })
    );
    // A movement after the close would start a life without a creation, with the same identity.
    let mut moved = recreated.clone();
    moved.lifecycle.pop();
    let mut deposit = movement(
        SECOND_POSITION,
        SOL_POOL,
        MovementKind::Deposit,
        (0, 500),
        Some(0),
    );
    deposit.at = at(3);
    moved.movements.push(deposit);
    assert_eq!(
        fold.book(&step(4, 4, &moved), &moved, &pools()),
        Err(FoldError::IdentityCollision {
            position: SECOND_POSITION
        })
    );
    assert_eq!(fold, before);
}

#[test]
fn refuses_a_close_of_the_wallets_life_that_names_another_owner() {
    let mut fold = fold();
    run(
        &mut fold,
        &[lifecycle(vec![created(POSITION, SOL_POOL, WALLET)])],
    );
    let before = fold.clone();
    let foreign_close = lifecycle(vec![closed(POSITION, OTHER_OWNER)]);
    assert_eq!(
        fold.book(&step(2, 2, &foreign_close), &foreign_close, &pools()),
        Err(FoldError::ClosedByAnotherOwner { position: POSITION })
    );
    assert_eq!(fold, before);
}

/// A transaction of an open life runs a DLMM instruction this version does not know: what it did
/// to the life is not counted, so the life closes estimated with an unknown outcome.
#[test]
fn marks_a_life_open_during_unknown_dlmm_activity() {
    use binsight_ledger::facts::{PositionHistory, QuoteUnits};
    use binsight_ledger::report::closed::Outcome;
    let unknown = binsight_dlmm::activity::TxActivity {
        has_unknown_program_activity: true,
        ..lifecycle(vec![])
    };
    let closed = life(
        SOL_POOL,
        vec![
            moves(vec![movement(
                POSITION,
                SOL_POOL,
                MovementKind::Withdrawal,
                (0, 500),
                Some(0),
            )]),
            unknown,
        ],
    );
    assert_eq!(closed[0].withdrawn, QuoteUnits(500));
    assert_eq!(closed[0].history, PositionHistory::UncountedActivity);
    assert_eq!(valued(&closed[0]).outcome, Outcome::Unknown);
}
