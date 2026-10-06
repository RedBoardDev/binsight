//! Synthetic row ownership and one real failed transaction retain explicit proof boundaries.
#[path = "common/lifetimes.rs"]
mod common;

use binsight_dlmm::activity::LifecycleFact;
use binsight_ledger::book::{EntryKind, PositionActivitySource, WalletContext};
use binsight_ledger::facts::PositionId;
use binsight_ledger::positions::{
    LifetimeError, PositionActivityOwnership, PositionLifetimes, PositionTransaction,
    TransactionOrderProof,
};
use binsight_solana::{Address, Signature};
use common::*;

const FOREIGN_POSITION: Address = Address::from_bytes([20; 32]);

fn identity(address: Address, seed: u8) -> PositionId {
    PositionId {
        address,
        opened_by: Signature::from_bytes([seed; 64]),
    }
}

#[expect(
    clippy::unwrap_used,
    reason = "the synthetic opening has consistent owned and foreign creation facts"
)]
fn replay_with_foreign() -> PositionLifetimes {
    let mut replay = PositionLifetimes::new(context());
    let mut opening = opening(1, 10);
    opening.activity.lifecycle.push(LifecycleFact::Created {
        at: at(1),
        position: FOREIGN_POSITION,
        pool: POOL,
        owner: FOREIGN,
    });
    replay.apply(&opening).unwrap();
    replay
}

#[test]
fn classifies_original_rows_after_a_foreign_prefix_and_instruction_sorting() {
    let mut replay = replay_with_foreign();
    let mut source = source(2, 11);
    let mut foreign = movement(3, 7, 0);
    foreign.position = FOREIGN_POSITION;
    source
        .activity
        .movements
        .extend([foreign, movement(1, 9, 0)]);
    let ownership = replay.apply(&source).unwrap();
    let foreign_row = PositionActivitySource::Movement {
        index: 0,
        at: at(3),
    };
    let owned_row = PositionActivitySource::Movement {
        index: 1,
        at: at(1),
    };
    assert_eq!(
        ownership.source_ownership(foreign_row),
        Ok(Some(PositionActivityOwnership::Foreign(identity(
            FOREIGN_POSITION,
            1
        ))))
    );
    assert_eq!(
        ownership.source_ownership(owned_row),
        Ok(Some(PositionActivityOwnership::Owned(identity(
            POSITION, 1
        ))))
    );
    assert_eq!(ownership.position_for(foreign_row), None);
    assert_eq!(
        ownership.position_for(owned_row),
        Some(identity(POSITION, 1))
    );
    for absent in [
        PositionActivitySource::Movement {
            index: 0,
            at: at(1),
        },
        PositionActivitySource::Movement {
            index: 2,
            at: at(3),
        },
        PositionActivitySource::RewardClaim {
            index: 0,
            at: at(3),
        },
    ] {
        assert_eq!(ownership.source_ownership(absent), Ok(None));
    }
    assert_eq!(
        ownership.positions().unwrap(),
        &std::collections::BTreeSet::from([POSITION])
    );
}

#[test]
fn classifies_reward_rows_by_vector_index_rather_than_program_reward_index() {
    let mut replay = replay_with_foreign();
    let mut source = source(2, 11);
    let mut foreign = reward(0, 7);
    foreign.position = FOREIGN_POSITION;
    foreign.reward_index = 19;
    let mut owned = reward(1, 9);
    owned.reward_index = 23;
    source.activity.reward_claims.extend([foreign, owned]);
    let ownership = replay.apply(&source).unwrap();
    assert_eq!(
        ownership.source_ownership(PositionActivitySource::RewardClaim {
            index: 0,
            at: at(0)
        }),
        Ok(Some(PositionActivityOwnership::Foreign(identity(
            FOREIGN_POSITION,
            1
        ))))
    );
    assert_eq!(
        ownership.source_ownership(PositionActivitySource::RewardClaim {
            index: 1,
            at: at(1)
        }),
        Ok(Some(PositionActivityOwnership::Owned(identity(
            POSITION, 1
        ))))
    );
    assert_eq!(
        ownership.source_ownership(PositionActivitySource::RewardClaim {
            index: 19,
            at: at(0)
        }),
        Ok(None)
    );
}

#[test]
fn refuses_to_classify_missing_creation_as_a_foreign_owner() {
    let mut replay = PositionLifetimes::new(context());
    let mut source = source(1, 10);
    source.activity.movements.push(movement(0, 7, 0));
    let ownership = replay.apply(&source).unwrap();
    let row = PositionActivitySource::Movement {
        index: 0,
        at: at(0),
    };
    assert_eq!(
        ownership.source_ownership(row),
        Err(LifetimeError::UnresolvedOwnership)
    );
    assert_eq!(ownership.position_for(row), None);
    assert_ne!(ownership.diagnostics(), []);
}

#[test]
fn associates_a_recreated_foreign_account_with_its_new_creation_identity() {
    let mut replay = PositionLifetimes::new(context());
    replay.apply(&opening(1, 10)).unwrap();
    replay.apply(&closing(2, 11)).unwrap();
    let mut recreated = source(3, 12);
    recreated.activity.lifecycle.push(created(0, FOREIGN));
    recreated.activity.movements.push(movement(1, 7, 0));
    let ownership = replay.apply(&recreated).unwrap();
    let row = PositionActivitySource::Movement {
        index: 0,
        at: at(1),
    };
    assert_eq!(
        ownership.source_ownership(row),
        Ok(Some(PositionActivityOwnership::Foreign(identity(
            POSITION, 3
        ))))
    );
    assert_eq!(ownership.position_for(row), None);
    let history = replay.finish();
    assert_eq!(history.lifetimes.len(), 1);
    assert_eq!(history.lifetimes.first().unwrap().id, identity(POSITION, 1));
    assert!(history.lifetimes.first().unwrap().closed.is_some());
}

#[test]
fn refuses_strict_proof_for_noncontiguous_sources_without_changing_the_legacy_lookup() {
    let mut context = context();
    context.sources_contiguous = false;
    let mut replay = PositionLifetimes::new(context);
    let mut source = opening(1, 10);
    source.activity.movements.push(movement(1, 7, 0));
    let ownership = replay.apply(&source).unwrap();
    let row = PositionActivitySource::Movement {
        index: 0,
        at: at(1),
    };
    assert_eq!(
        ownership.source_ownership(row),
        Err(LifetimeError::UnresolvedOwnership)
    );
    assert_eq!(ownership.position_for(row), Some(identity(POSITION, 1)));
    assert_ne!(ownership.diagnostics(), []);
}

#[test]
fn publishes_no_associations_after_a_late_pool_error_and_retries_the_same_signature() {
    let mut replay = replay_with_foreign();
    let mut source = source(2, 11);
    let mut foreign = movement(0, 7, 0);
    foreign.position = FOREIGN_POSITION;
    let mut invalid = movement(1, 9, 0);
    invalid.pool = book::address(21);
    source.activity.movements.extend([foreign, invalid]);
    let before = format!("{replay:?}");
    assert_eq!(
        replay.apply(&source),
        Err(LifetimeError::PoolMismatch { position: POSITION })
    );
    assert_eq!(format!("{replay:?}"), before);
    source.activity.movements.last_mut().unwrap().pool = POOL;
    let ownership = replay.apply(&source).unwrap();
    assert_eq!(
        ownership.source_ownership(PositionActivitySource::Movement {
            index: 0,
            at: at(0)
        }),
        Ok(Some(PositionActivityOwnership::Foreign(identity(
            FOREIGN_POSITION,
            1
        ))))
    );
    assert_eq!(
        ownership.source_ownership(PositionActivitySource::Movement {
            index: 1,
            at: at(1)
        }),
        Ok(Some(PositionActivityOwnership::Owned(identity(
            POSITION, 1
        ))))
    );
}

#[test]
fn retains_the_independent_fee_of_a_real_failed_close_without_activity_associations() {
    let transaction = binsight_solana::transaction::read(include_bytes!(
        "../../../tests/fixtures/mainnet/failed-close/tx-1.json"
    ))
    .unwrap();
    let events = binsight_dlmm::decode_events(&transaction).unwrap();
    let activity = binsight_dlmm::position_activity(&transaction, &events).unwrap();
    assert_eq!(activity, binsight_dlmm::activity::TxActivity::default());
    let mut context = context();
    context.wallet = transaction.fee_payer;
    context.observed_at = transaction.block_time.unwrap();
    let wallet = WalletContext::new(transaction.fee_payer);
    let source = PositionTransaction {
        wallet: transaction.fee_payer,
        order: transaction
            .transaction_index
            .map(|index| TransactionOrderProof::Canonical { index }),
        transaction,
        activity,
    };
    let mut replay = PositionLifetimes::new(context);
    let bundle = replay.book_and_apply(source, wallet).unwrap();
    assert_eq!(
        bundle
            .ownership()
            .source_ownership(PositionActivitySource::Movement {
                index: 0,
                at: at(0)
            }),
        Ok(None)
    );
    assert!(
        bundle
            .entries()
            .iter()
            .any(|entry| entry.kind == EntryKind::FailedTxFee)
    );
    assert_eq!(replay.finish().lifetimes, []);
}
