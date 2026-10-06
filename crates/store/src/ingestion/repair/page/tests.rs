//! What a repair page writes, on a real database.

use binsight_core::credits::Priority;
use rusqlite::params;

use super::*;
use crate::database::test_database::{assert_queries_prepare, migrated_store};
use crate::ingestion::test_pages::{
    WALLET, fetched, history_page, later, listed, listed_at, store_with_wallet,
};
use crate::ingestion::{FetchFailure, FetchSetback, RetryState};
use crate::store::Store;

fn repair_page(signatures: Vec<ListedSignature>) -> RepairPage {
    RepairPage {
        wallet: WALLET,
        signatures,
        fetch_priority: Priority::CatchUp,
        listed_at: later(600),
    }
}

/// A store whose wallet lists the signatures made of bytes 2 and 3, the first one fetched.
async fn listed_store() -> (tempfile::TempDir, Store) {
    let (folder, store) = store_with_wallet().await;
    let page = history_page(WALLET, vec![listed(2, 20), listed(3, 10)]);
    store.signatures().record_listing(page).await.unwrap();
    store
        .fetch_queue()
        .complete(fetched(2, b"{}"))
        .await
        .unwrap();
    (folder, store)
}

#[tokio::test]
async fn prepares_every_query_against_the_schema() {
    assert_queries_prepare(&[
        INSERT_SIGNATURE,
        FINALIZE_SIGNATURE,
        INSERT_STORED_TASK,
        INSERT_TASK,
        BRING_FORWARD,
        COUNT_FOUND,
    ])
    .await;
}

#[tokio::test]
async fn lists_and_queues_a_signature_the_wallet_missed_without_moving_the_cursor() {
    let (_folder, store) = listed_store().await;
    let cursor = store.wallets().list().await.unwrap()[0].cursor;

    let page = repair_page(vec![listed(2, 20), listed(5, 15), listed(3, 10)]);
    let findings = store.repairs().record_page(page).await.unwrap();

    assert_eq!(findings.missing, 1);
    assert_eq!(findings.brought_forward, 0);
    assert_eq!(store.wallets().list().await.unwrap()[0].cursor, cursor);
    let counts = store.fetch_queue().counts(WALLET).await.unwrap();
    assert_eq!((counts.listed, counts.fetched, counts.pending), (3, 1, 2));
    let progress = store.wallets().progress().await.unwrap();
    assert_eq!(progress[0].listing.listed, 3);
    let due = store
        .fetch_queue()
        .due(later(600), 10, Priority::CatchUp)
        .await
        .unwrap();
    assert_eq!(due.len(), 1);
    assert_eq!(due[0].signature, listed(5, 15).signature);
}

#[tokio::test]
async fn never_queues_a_missing_signature_whose_transaction_is_already_stored() {
    let (_folder, store) = listed_store().await;
    let other = Address::from_bytes([9; 32]);
    store.wallets().add(other, listed_at()).await.unwrap();

    let page = RepairPage {
        wallet: other,
        ..repair_page(vec![listed(2, 20)])
    };
    let findings = store.repairs().record_page(page).await.unwrap();

    assert_eq!(findings.missing, 1);
    let counts = store.fetch_queue().counts(other).await.unwrap();
    assert_eq!((counts.listed, counts.fetched), (1, 1));
    let due = store
        .fetch_queue()
        .due(later(600), 10, Priority::History)
        .await
        .unwrap();
    assert!(
        due.iter()
            .all(|task| task.signature != listed(2, 20).signature)
    );
}

#[tokio::test]
async fn marks_fetched_a_missing_signature_stored_without_any_task() {
    let (_folder, store) = store_with_wallet().await;
    store
        .raw_tx()
        .insert_if_absent(crate::raw_tx::tests::sample_record(6))
        .await
        .unwrap();

    let findings = store
        .repairs()
        .record_page(repair_page(vec![listed(6, 30)]))
        .await
        .unwrap();

    assert_eq!(findings.missing, 1);
    let counts = store.fetch_queue().counts(WALLET).await.unwrap();
    assert_eq!((counts.fetched, counts.pending), (1, 0));
}

#[tokio::test]
async fn brings_forward_a_listed_signature_whose_fetch_came_back_empty() {
    let (_folder, store) = listed_store().await;
    let empty = FetchFailure {
        signature: listed(3, 10).signature,
        setback: FetchSetback::RetryAt {
            state: RetryState::Failed,
            at: later(86_400),
        },
        attempts: 9,
        error: None,
        updated_at: listed_at(),
    };
    store.fetch_queue().record_failure(empty).await.unwrap();

    let findings = store
        .repairs()
        .record_page(repair_page(vec![listed(3, 10)]))
        .await
        .unwrap();

    assert_eq!(
        findings,
        RepairFindings {
            missing: 0,
            brought_forward: 1
        }
    );
    let due = store
        .fetch_queue()
        .due(later(600), 10, Priority::CatchUp)
        .await
        .unwrap();
    assert_eq!(due.len(), 1);
    assert_eq!((due[0].attempts, due[0].priority), (0, Priority::CatchUp));
}

#[tokio::test]
async fn changes_nothing_for_signatures_already_listed_and_fetched() {
    let (_folder, store) = listed_store().await;

    let findings = store
        .repairs()
        .record_page(repair_page(vec![listed(2, 20)]))
        .await
        .unwrap();

    assert_eq!(findings, RepairFindings::default());
    let counts = store.fetch_queue().counts(WALLET).await.unwrap();
    assert_eq!((counts.listed, counts.fetched), (2, 1));
    let stored_count: i64 = store
        .database()
        .read(|connection| {
            Ok(connection.query_row(
                "SELECT listed_count FROM wallet_cursor WHERE wallet = ?1",
                params![WALLET.to_string()],
                |row| row.get(0),
            )?)
        })
        .await
        .unwrap();
    assert_eq!(stored_count, 2);
}

#[tokio::test]
async fn refuses_a_page_for_a_wallet_that_is_not_tracked() {
    let (_folder, store) = migrated_store().await;

    let attempt = store.repairs().record_page(repair_page(Vec::new())).await;

    assert!(matches!(attempt, Err(StoreError::UnknownWallet { .. })));
}
