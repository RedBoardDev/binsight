//! Canonical and wallet-local source spaces remain explicit and never use block time as order.
#[path = "common/lifetimes.rs"]
mod common;

use binsight_ledger::positions::{
    LifetimeDiagnostic, LifetimeError, PositionLifetimes, TransactionOrderProof,
};
use common::*;

fn canonical(source: &mut binsight_ledger::positions::PositionTransaction, index: u32) {
    source.transaction.transaction_index = Some(index);
    source.order = Some(TransactionOrderProof::Canonical { index });
}

fn ordinal(source: &mut binsight_ledger::positions::PositionTransaction, rank: u32) {
    source.order = Some(TransactionOrderProof::WalletOrdinal { rank });
}

#[test]
fn orders_same_slot_lifecycle_by_the_original_index_despite_inverted_timestamps() {
    let mut replay = PositionLifetimes::new(context());
    let mut opening = opening(1, 10);
    canonical(&mut opening, 2);
    opening.transaction.block_time = Some(time(100));
    let mut closing = closing(2, 10);
    canonical(&mut closing, 3);
    closing.transaction.block_time = Some(time(90));
    replay.apply(&opening).unwrap();
    replay.apply(&closing).unwrap();
    let history = replay.finish();
    assert!(history.lifetimes.first().unwrap().closed.is_some());
    assert!(history.diagnostics.iter().any(|diagnostic| matches!(
        diagnostic,
        LifetimeDiagnostic::InconsistentLifetimeDates { .. }
    )));
}

#[test]
fn keeps_uniform_fallback_provenance_separate_from_original_canonical_indices() {
    let mut replay = PositionLifetimes::new(context());
    let mut opening = opening(1, 10);
    ordinal(&mut opening, 1);
    opening.transaction.transaction_index = Some(20);
    let mut closing = closing(2, 10);
    ordinal(&mut closing, 0);
    closing.transaction.transaction_index = Some(40);
    replay.apply(&opening).unwrap();
    replay.apply(&closing).unwrap();
    let history = replay.finish();
    let lifetime = history.lifetimes.first().unwrap();
    assert_eq!(
        lifetime.opened.order,
        Some(TransactionOrderProof::WalletOrdinal { rank: 1 })
    );
    assert_eq!(
        lifetime.closed.unwrap().order,
        Some(TransactionOrderProof::WalletOrdinal { rank: 0 })
    );
    assert_eq!(opening.transaction.transaction_index, Some(20));
}

#[test]
fn refuses_a_canonical_proof_that_differs_from_the_original_transaction_index() {
    let mut replay = PositionLifetimes::new(context());
    let mut opening = opening(1, 10);
    opening.order = Some(TransactionOrderProof::Canonical { index: 9 });
    assert_eq!(
        replay.apply(&opening),
        Err(LifetimeError::CanonicalIndexMismatch)
    );
    assert_eq!(replay.finish().lifetimes, Vec::new());
}

#[test]
fn refuses_mixed_or_missing_order_spaces_within_one_slot() {
    for proof in [None, Some(TransactionOrderProof::WalletOrdinal { rank: 0 })] {
        let mut replay = PositionLifetimes::new(context());
        replay.apply(&opening(1, 10)).unwrap();
        let mut closing = closing(2, 10);
        closing.order = proof;
        assert_eq!(
            replay.apply(&closing),
            Err(LifetimeError::AmbiguousTransactionOrder)
        );
        assert!(replay.finish().lifetimes.first().unwrap().closed.is_none());
    }
}

#[test]
fn refuses_duplicate_or_reversed_ranks_without_using_signature_as_a_tie_breaker() {
    for rank in [1, 2] {
        let mut replay = PositionLifetimes::new(context());
        let mut opening = opening(2, 10);
        ordinal(&mut opening, 1);
        opening.transaction.transaction_index = None;
        replay.apply(&opening).unwrap();
        let mut closing = closing(1, 10);
        ordinal(&mut closing, rank);
        closing.transaction.transaction_index = None;
        assert_eq!(replay.apply(&closing), Err(LifetimeError::UnorderedSources));
    }
}

#[test]
fn verifies_relative_canonical_indices_across_fallback_rows_with_an_unknown_index_between() {
    let mut replay = PositionLifetimes::new(context());
    let mut opening = opening(1, 10);
    ordinal(&mut opening, 2);
    opening.transaction.transaction_index = Some(40);
    replay.apply(&opening).unwrap();
    let mut middle = source(2, 10);
    ordinal(&mut middle, 1);
    middle.transaction.transaction_index = None;
    replay.apply(&middle).unwrap();
    let mut closing = closing(3, 10);
    ordinal(&mut closing, 0);
    closing.transaction.transaction_index = Some(20);
    assert_eq!(replay.apply(&closing), Err(LifetimeError::UnorderedSources));
    assert!(replay.finish().lifetimes.first().unwrap().closed.is_none());
}

#[test]
fn keeps_a_missing_order_diagnostic_without_fabricating_an_index_for_a_lone_slot() {
    let mut replay = PositionLifetimes::new(context());
    let mut opening = opening(1, 10);
    opening.order = None;
    opening.transaction.transaction_index = None;
    replay.apply(&opening).unwrap();
    let history = replay.finish();
    assert_eq!(history.lifetimes.first().unwrap().opened.order, None);
    assert_eq!(
        history.diagnostics,
        vec![LifetimeDiagnostic::MissingTransactionOrder {
            signature: opening.transaction.signature
        }]
    );
}

#[test]
fn refuses_repeated_transactions_and_reverse_slots_without_partial_changes() {
    let mut replay = PositionLifetimes::new(context());
    let opening = opening(1, 10);
    replay.apply(&opening).unwrap();
    assert_eq!(
        replay.apply(&opening),
        Err(LifetimeError::DuplicateTransaction {
            signature: opening.transaction.signature
        })
    );
    assert_eq!(
        replay.apply(&closing(2, 9)),
        Err(LifetimeError::UnorderedSources)
    );
    replay.apply(&closing(2, 11)).unwrap();
    assert_eq!(replay.finish().lifetimes.len(), 1);
}
