//! Synthetic lifetimes prove ownership and source identity without valuing or fetching amounts.
#[path = "common/lifetimes.rs"]
mod common;

use binsight_ledger::book::PositionActivitySource;
use binsight_ledger::facts::PositionId;
use binsight_ledger::positions::{LifetimeError, PositionLifetimes, RawActivityEvidence};
use binsight_solana::Signature;
use binsight_solana::transaction::TxOutcome;
use common::*;

#[test]
fn opens_from_the_created_owner_and_closes_only_on_successful_execution() {
    let mut replay = PositionLifetimes::new(context());
    let mut opening = opening(1, 10);
    opening.transaction.fee_payer = FOREIGN;
    assert!(
        replay
            .apply(&opening)
            .unwrap()
            .positions()
            .unwrap()
            .contains(&POSITION)
    );
    let mut failed = source(2, 11);
    failed.transaction.outcome = TxOutcome::Failed {
        error: "{}".to_owned(),
    };
    replay.apply(&failed).unwrap();
    let closing = closing(3, 12);
    assert!(
        replay
            .apply(&closing)
            .unwrap()
            .positions()
            .unwrap()
            .contains(&POSITION)
    );
    let history = replay.finish();
    assert_eq!(history.diagnostics, Vec::new());
    let lifetime = history.lifetimes.first().unwrap();
    assert_eq!(lifetime.owner, WALLET);
    assert_eq!(lifetime.opened.signature, opening.transaction.signature);
    assert_eq!(
        lifetime.closed.unwrap().signature,
        closing.transaction.signature
    );
    assert_eq!(lifetime.raw_activity, RawActivityEvidence::ProvenEmpty);
}

#[test]
fn keeps_a_funded_position_open_without_a_successful_close() {
    let mut replay = PositionLifetimes::new(context());
    replay.apply(&opening(1, 10)).unwrap();
    let mut activity = source(2, 11);
    activity
        .transaction
        .native_balances
        .push(book::native(POSITION, 100, 100));
    assert!(
        replay
            .apply(&activity)
            .unwrap()
            .positions()
            .unwrap()
            .contains(&POSITION)
    );
    assert!(replay.finish().lifetimes.first().unwrap().closed.is_none());
}

#[test]
fn creates_a_new_identity_when_the_same_account_is_recreated_in_another_transaction() {
    let mut replay = PositionLifetimes::new(context());
    replay.apply(&opening(1, 10)).unwrap();
    replay.apply(&closing(2, 11)).unwrap();
    replay.apply(&opening(3, 12)).unwrap();
    let history = replay.finish();
    assert_eq!(history.lifetimes.len(), 2);
    assert_eq!(
        history
            .lifetimes
            .iter()
            .filter(|life| life.closed.is_some())
            .count(),
        1
    );
    let ids: Vec<_> = history.lifetimes.iter().map(|life| life.id).collect();
    assert!(ids.contains(&PositionId {
        address: POSITION,
        opened_by: Signature::from_bytes([1; 64])
    }));
    assert!(ids.contains(&PositionId {
        address: POSITION,
        opened_by: Signature::from_bytes([3; 64])
    }));
}

#[test]
fn drops_ownership_when_a_closed_account_is_recreated_for_another_owner() {
    let mut replay = PositionLifetimes::new(context());
    replay.apply(&opening(1, 10)).unwrap();
    replay.apply(&closing(2, 11)).unwrap();
    let mut foreign = source(3, 12);
    foreign.activity.lifecycle.push(created(0, FOREIGN));
    foreign.activity.movements.push(movement(1, 20, 30));
    let ownership = replay.apply(&foreign).unwrap();
    assert_eq!(
        ownership.positions().unwrap(),
        &std::collections::BTreeSet::new()
    );
    assert_eq!(
        ownership.position_for(PositionActivitySource::Movement {
            index: 0,
            at: at(1)
        }),
        None
    );
    assert_eq!(replay.finish().lifetimes.len(), 1);
}

#[test]
fn keeps_the_original_source_indices_after_ignoring_a_foreign_position() {
    let mut replay = PositionLifetimes::new(context());
    let mut opening = opening(1, 10);
    let foreign_position = book::address(20);
    let mut foreign_create = created(1, FOREIGN);
    if let binsight_dlmm::activity::LifecycleFact::Created { position, .. } = &mut foreign_create {
        *position = foreign_position;
    }
    opening.activity.lifecycle.push(foreign_create);
    replay.apply(&opening).unwrap();
    let mut source = source(2, 11);
    let mut foreign_move = movement(0, 99, 0);
    foreign_move.position = foreign_position;
    source
        .activity
        .movements
        .extend([foreign_move, movement(1, 7, 9)]);
    source.activity.reward_claims.push(reward(2, 4));
    let ownership = replay.apply(&source).unwrap();
    let expected = Some(PositionId {
        address: POSITION,
        opened_by: opening.transaction.signature,
    });
    assert_eq!(
        ownership.position_for(PositionActivitySource::Movement {
            index: 0,
            at: at(0)
        }),
        None
    );
    assert_eq!(
        ownership.position_for(PositionActivitySource::Movement {
            index: 1,
            at: at(1)
        }),
        expected
    );
    assert_eq!(
        ownership.position_for(PositionActivitySource::Movement {
            index: 0,
            at: at(1)
        }),
        None
    );
    assert_eq!(
        ownership.position_for(PositionActivitySource::RewardClaim {
            index: 0,
            at: at(2)
        }),
        expected
    );
}

#[test]
fn refuses_a_same_signature_identity_collision_without_mutating_the_transaction() {
    let mut replay = PositionLifetimes::new(context());
    let mut source = opening(1, 10);
    source
        .activity
        .lifecycle
        .extend([closed(1, WALLET), created(2, WALLET)]);
    assert!(matches!(
        replay.apply(&source),
        Err(LifetimeError::PositionIdCollision { .. })
    ));
    let mut retry = source.clone();
    retry.activity.lifecycle.truncate(1);
    replay.apply(&retry).unwrap();
    assert_eq!(replay.finish().lifetimes.len(), 1);
}

#[test]
fn refuses_owners_changing_inside_one_transaction_before_address_only_booking() {
    let mut replay = PositionLifetimes::new(context());
    replay.apply(&opening(1, 10)).unwrap();
    let mut source = closing(2, 11);
    source.activity.lifecycle.push(created(1, FOREIGN));
    assert_eq!(
        replay.apply(&source),
        Err(LifetimeError::AmbiguousOwnershipWithinTransaction { position: POSITION })
    );
    assert!(replay.finish().lifetimes.first().unwrap().closed.is_none());
}

#[test]
fn refuses_a_pool_contradiction_after_a_staged_close_without_committing_that_close() {
    let mut replay = PositionLifetimes::new(context());
    replay.apply(&opening(1, 10)).unwrap();
    let mut source = source(2, 11);
    source
        .activity
        .lifecycle
        .extend([closed(0, WALLET), created(1, WALLET)]);
    let mut invalid = movement(2, 1, 0);
    invalid.pool = FOREIGN;
    source.activity.movements.push(invalid);
    assert_eq!(
        replay.apply(&source),
        Err(LifetimeError::PoolMismatch { position: POSITION })
    );
    let history = replay.finish();
    assert_eq!(history.lifetimes.len(), 1);
    assert!(history.lifetimes.first().unwrap().closed.is_none());
}

#[test]
fn refuses_activity_outside_a_known_closed_lifetime() {
    let mut replay = PositionLifetimes::new(context());
    replay.apply(&opening(1, 10)).unwrap();
    replay.apply(&closing(2, 11)).unwrap();
    let mut source = source(3, 12);
    source.activity.movements.push(movement(0, 1, 0));
    assert_eq!(
        replay.apply(&source),
        Err(LifetimeError::MovementOutsideLifetime { position: POSITION })
    );
}

#[test]
fn refuses_conflicting_lifecycle_and_movement_rows_with_no_cross_vector_order() {
    let mut replay = PositionLifetimes::new(context());
    let mut source = opening(1, 10);
    source.activity.movements.push(movement(0, 1, 0));
    assert_eq!(
        replay.apply(&source),
        Err(LifetimeError::AmbiguousActivityOrder {
            position: POSITION,
            at: at(0)
        })
    );
    assert_eq!(replay.finish().lifetimes, Vec::new());
}
