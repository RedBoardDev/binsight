//! Synthetic normalized activities preserve original vector indices and independent fees.
#[path = "common/lifetimes.rs"]
mod common;
#[path = "common/normalization.rs"]
mod normalization;

use binsight_core::units::RawTokenAmount;
use binsight_dlmm::activity::{LifecycleFact, MovementKind};
use binsight_ledger::book::{EntryKind, PositionActivitySource, WalletContext};
use binsight_ledger::positions::{
    NormalizedPositionActivity, PositionLifetimes, TransactionOrderProof,
};
use binsight_solana::{programs::TokenProgram, transaction::TxOutcome};
use common::*;
use normalization::*;

#[test]
fn keeps_original_indices_when_foreign_activity_precedes_the_owned_movement() {
    let mut replay = replay();
    let mut source = deposit();
    let foreign = book::address(22);
    source.activity.lifecycle.push(LifecycleFact::Created {
        at: at(1),
        position: foreign,
        pool: POOL,
        owner: FOREIGN,
    });
    let mut foreign_movement = movement(2, 7, 0);
    foreign_movement.position = foreign;
    source.activity.movements.insert(0, foreign_movement);
    let bundle = replay
        .book_and_apply(source, WalletContext::new(WALLET))
        .unwrap();
    let [NormalizedPositionActivity::Movement { source, .. }] = bundle.activities() else {
        panic!("one owned activity")
    };
    assert_eq!(
        *source,
        PositionActivitySource::Movement {
            index: 1,
            at: at(0)
        }
    );
    assert_eq!(bundle.source().activity.movements.len(), 2);
}

#[test]
fn keeps_reward_vector_index_distinct_from_reward_program_index_and_its_mint() {
    let mut replay = replay();
    let mut source = source(2, 11);
    let reward = reward(2, 123);
    let mint = reward.mint.unwrap();
    source.activity.reward_claims.push(reward);
    source
        .transaction
        .token_balances
        .push(book::token(book::address(2), WALLET, mint, 0, 123));
    source
        .transaction
        .native_balances
        .push(book::native(book::address(2), 200, 200));
    let bundle = replay
        .book_and_apply(source, WalletContext::new(WALLET))
        .unwrap();
    let [NormalizedPositionActivity::RewardClaim { source, reward, .. }] = bundle.activities()
    else {
        panic!("one reward")
    };
    assert_eq!(
        *source,
        PositionActivitySource::RewardClaim {
            index: 0,
            at: at(2)
        }
    );
    assert_eq!(reward.reward_index, 1);
    assert_eq!(reward.mint, Some(mint));
    assert_eq!(reward.amount, RawTokenAmount(123));
}

#[test]
fn preserves_both_rebalance_halves_without_netting_their_raw_transfers() {
    let mut replay = replay();
    let mut source = deposit();
    let mut withdrawal = source.activity.movements.first().copied().unwrap();
    withdrawal.kind = MovementKind::RebalanceWithdrawal;
    source.activity.movements.first_mut().unwrap().kind = MovementKind::RebalanceDeposit;
    source.activity.movements.insert(0, withdrawal);
    source.transaction.token_balances.first_mut().unwrap().post = RawTokenAmount(1_000);
    source.transaction.token_balances[1].post = RawTokenAmount(0);
    for balance in &mut source.transaction.token_balances {
        balance.program = TokenProgram::Token;
    }
    source.transaction.instructions.truncate(1);
    let bundle = replay
        .book_and_apply(source, WalletContext::new(WALLET))
        .unwrap();
    assert_eq!(bundle.activities().len(), 2);
    for activity in bundle.activities() {
        let NormalizedPositionActivity::Movement { movement, .. } = activity else {
            panic!("pool movement")
        };
        assert_eq!(movement.x, RawTokenAmount(1_000));
    }
    assert_eq!(
        bundle
            .entries()
            .iter()
            .filter(|entry| entry.source.is_some())
            .count(),
        2
    );
}

#[test]
fn books_failed_execution_fees_without_creating_a_lifetime_or_normalized_activity() {
    let mut replay = PositionLifetimes::new(context());
    let mut source = source(1, 10);
    source.transaction.outcome = TxOutcome::Failed {
        error: "synthetic failure".to_owned(),
    };
    source.order = None;
    let bundle = replay
        .book_and_apply(source, WalletContext::new(WALLET))
        .unwrap();
    assert_eq!(bundle.activities(), []);
    assert_eq!(bundle.source().order, None::<TransactionOrderProof>);
    assert!(bundle.entries().iter().all(|entry| entry.source.is_none()));
    assert!(
        bundle
            .entries()
            .iter()
            .any(|entry| entry.kind == EntryKind::FailedTxFee)
    );
    assert_eq!(replay.finish().lifetimes, Vec::new());
}
