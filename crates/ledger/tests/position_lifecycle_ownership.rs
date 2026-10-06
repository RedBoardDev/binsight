//! Synthetic lifecycle associations stay scoped to the original replayed and booked source.
#[path = "common/lifetimes.rs"]
mod common;

use binsight_dlmm::activity::LifecycleFact;
use binsight_ledger::book::{BookError, EntryKind, WalletContext};
use binsight_ledger::facts::PositionId;
use binsight_ledger::positions::{
    LifetimeDiagnostic, NormalizationError, PositionLifetimes, TransactionOrderProof,
};
use binsight_solana::{Signature, transaction::TxOutcome};
use common::*;

fn id(seed: u8) -> PositionId {
    PositionId {
        address: POSITION,
        opened_by: Signature::from_bytes([seed; 64]),
    }
}

#[test]
fn associates_a_shell_creation_and_empty_close_with_the_same_opening_signature() {
    let mut replay = PositionLifetimes::new(context());
    let opened = replay
        .book_and_apply(opening(1, 10), WalletContext::new(WALLET))
        .unwrap();
    assert_eq!(
        opened.ownership().position_for_lifecycle(0, at(0)),
        Some(id(1))
    );
    let closed = replay
        .book_and_apply(closing(2, 11), WalletContext::new(WALLET))
        .unwrap();
    assert_eq!(closed.activities(), []);
    assert_eq!(closed.source().activity.movements, []);
    assert_eq!(
        closed.ownership().position_for_lifecycle(0, at(0)),
        Some(id(1))
    );
    assert_eq!(
        closed.source().transaction.signature,
        Signature::from_bytes([2; 64])
    );
}

#[test]
fn keeps_distinct_lifecycle_identities_when_an_account_is_recreated() {
    let mut replay = PositionLifetimes::new(context());
    replay
        .book_and_apply(opening(1, 10), WalletContext::new(WALLET))
        .unwrap();
    let closed = replay
        .book_and_apply(closing(2, 11), WalletContext::new(WALLET))
        .unwrap();
    let reopened = replay
        .book_and_apply(opening(3, 12), WalletContext::new(WALLET))
        .unwrap();
    assert_eq!(
        closed.ownership().position_for_lifecycle(0, at(0)),
        Some(id(1))
    );
    assert_eq!(
        reopened.ownership().position_for_lifecycle(0, at(0)),
        Some(id(3))
    );
    assert_eq!(replay.finish().lifetimes.len(), 2);
}

#[test]
fn keeps_original_vector_indices_after_a_foreign_prefix_and_instruction_sorting() {
    let mut source = source(1, 10);
    let other = book::address(13);
    source.activity.lifecycle = vec![
        LifecycleFact::Created {
            at: at(2),
            position: book::address(20),
            pool: POOL,
            owner: FOREIGN,
        },
        created(3, WALLET),
        LifecycleFact::Created {
            at: at(0),
            position: other,
            pool: POOL,
            owner: WALLET,
        },
    ];
    let mut replay = PositionLifetimes::new(context());
    let bundle = replay
        .book_and_apply(source.clone(), WalletContext::new(WALLET))
        .unwrap();
    assert_eq!(bundle.source(), &source);
    assert_eq!(bundle.ownership().position_for_lifecycle(0, at(2)), None);
    assert_eq!(
        bundle.ownership().position_for_lifecycle(1, at(3)),
        Some(id(1))
    );
    assert_eq!(
        bundle.ownership().position_for_lifecycle(2, at(0)),
        Some(PositionId {
            address: other,
            opened_by: Signature::from_bytes([1; 64])
        })
    );
    assert_eq!(bundle.ownership().position_for_lifecycle(1, at(0)), None);
    assert_eq!(bundle.ownership().position_for_lifecycle(3, at(3)), None);
}

#[test]
fn associates_an_owned_close_after_a_known_foreign_close_without_reindexing() {
    let foreign_position = book::address(20);
    let mut source = opening(1, 10);
    source.activity.lifecycle.insert(
        0,
        LifecycleFact::Created {
            at: at(1),
            position: foreign_position,
            pool: POOL,
            owner: FOREIGN,
        },
    );
    let mut replay = PositionLifetimes::new(context());
    replay
        .book_and_apply(source, WalletContext::new(WALLET))
        .unwrap();
    let mut source = closing(2, 11);
    source.activity.lifecycle[0] = closed(1, WALLET);
    source.activity.lifecycle.insert(
        0,
        LifecycleFact::Closed {
            at: at(0),
            position: foreign_position,
            owner: FOREIGN,
        },
    );
    let bundle = replay
        .book_and_apply(source, WalletContext::new(WALLET))
        .unwrap();
    assert_eq!(bundle.ownership().position_for_lifecycle(0, at(0)), None);
    assert_eq!(
        bundle.ownership().position_for_lifecycle(1, at(1)),
        Some(id(1))
    );
}

#[test]
fn publishes_no_lifecycle_association_after_booking_failure_and_retries_the_same_signature() {
    let mut replay = PositionLifetimes::new(context());
    let mut broken = opening(1, 10);
    broken.activity.movements.push(movement(1, 1_000, 0));
    assert_eq!(
        replay.book_and_apply(broken, WalletContext::new(WALLET)),
        Err(NormalizationError::Book(BookError::MissingMovementMint {
            position: POSITION
        }))
    );
    let corrected = replay
        .book_and_apply(opening(1, 10), WalletContext::new(WALLET))
        .unwrap();
    assert_eq!(
        corrected.ownership().position_for_lifecycle(0, at(0)),
        Some(id(1))
    );
    let closed = replay
        .book_and_apply(closing(2, 11), WalletContext::new(WALLET))
        .unwrap();
    assert_eq!(
        closed.ownership().position_for_lifecycle(0, at(0)),
        Some(id(1))
    );
    assert_eq!(replay.finish().lifetimes.len(), 1);
}

#[test]
fn preserves_a_known_lifecycle_identity_with_missing_time_and_wallet_ordinal_order() {
    let mut replay = PositionLifetimes::new(context());
    let mut source = opening(1, 10);
    source.transaction.block_time = None;
    source.transaction.transaction_index = None;
    source.order = Some(TransactionOrderProof::WalletOrdinal { rank: 7 });
    let bundle = replay
        .book_and_apply(source, WalletContext::new(WALLET))
        .unwrap();
    assert_eq!(
        bundle.ownership().position_for_lifecycle(0, at(0)),
        Some(id(1))
    );
    assert_eq!(
        bundle.source().order,
        Some(TransactionOrderProof::WalletOrdinal { rank: 7 })
    );
    assert_eq!(bundle.source().transaction.block_time, None);
    assert_eq!(bundle.source().transaction.transaction_index, None);
    assert_ne!(bundle.ownership().diagnostics(), []);
}

#[test]
fn takes_the_owner_of_a_close_whose_creation_is_unknown_from_its_event() {
    let mut replay = PositionLifetimes::new(context());
    let ownership = replay.apply(&closing(1, 10)).unwrap();
    assert_eq!(ownership.position_for_lifecycle(0, at(0)), None);
    assert_eq!(
        ownership.positions(),
        Ok(&std::collections::BTreeSet::from([POSITION]))
    );
    assert!(ownership.unknown_creations().contains(&POSITION));
    assert!(ownership.diagnostics().iter().any(|diagnostic| matches!(diagnostic, LifetimeDiagnostic::MissingCreation { position, .. } if *position == POSITION)));
    assert_eq!(replay.finish().lifetimes, []);
}

#[test]
fn keeps_failed_execution_lifecycle_empty_and_its_independent_fee_known() {
    let mut replay = PositionLifetimes::new(context());
    let mut source = source(1, 10);
    source.transaction.outcome = TxOutcome::Failed {
        error: "synthetic failed execution".to_owned(),
    };
    source.order = None;
    let bundle = replay
        .book_and_apply(source, WalletContext::new(WALLET))
        .unwrap();
    assert_eq!(bundle.source().activity.lifecycle, []);
    assert_eq!(bundle.ownership().position_for_lifecycle(0, at(0)), None);
    assert!(
        bundle
            .entries()
            .iter()
            .any(|entry| entry.kind == EntryKind::FailedTxFee)
    );
    assert_eq!(replay.finish().lifetimes, []);
}
