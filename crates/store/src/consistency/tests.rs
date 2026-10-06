//! The registry's invariants, broken by hand on a real database, found and restored.

use binsight_core::credits::Priority;
use binsight_solana::Signature;
use rusqlite::params;

use super::{CurrentDecoder, RegistryInspection};
use crate::ingestion::test_pages::{
    WALLET, history_page, later, listed, listed_at, store_with_wallet,
};
use crate::raw_tx::tests::sample_record;
use crate::store::Store;
use crate::{DecodeOutcome, DecodeRecord};

fn current() -> CurrentDecoder {
    CurrentDecoder {
        name: "dlmm".to_owned(),
        decoder_version: 2,
        reader_version: 1,
    }
}

async fn inspect(store: &Store) -> RegistryInspection {
    store.consistency().inspect(current()).await.unwrap()
}

/// A store tracking [`WALLET`], whose history lists the signatures made of bytes 2 and 3.
async fn listed_store() -> (tempfile::TempDir, Store) {
    let (folder, store) = store_with_wallet().await;
    let page = history_page(WALLET, vec![listed(2, 20), listed(3, 10)]);
    store.signatures().record_listing(page).await.unwrap();
    (folder, store)
}

/// Runs `sql` on the database, with the signature made of `seed` bytes as its parameter.
async fn break_by_hand(store: &Store, sql: &'static str, seed: u8) {
    let signature = Signature::from_bytes([seed; 64]).to_string();
    store
        .database()
        .write(move |connection| Ok(connection.execute(sql, params![signature])?))
        .await
        .unwrap();
}

async fn store_transaction(store: &Store, seed: u8) {
    store
        .raw_tx()
        .insert_if_absent(sample_record(seed))
        .await
        .unwrap();
}

#[tokio::test]
async fn finds_nothing_wrong_in_a_registry_kept_in_step() {
    let (_folder, store) = listed_store().await;

    let inspection = inspect(&store).await;

    assert_eq!(inspection.wallets.len(), 1);
    let wallet = inspection.wallets[0];
    assert_eq!((wallet.counted, wallet.listed), (2, 2));
    assert!(wallet.is_top_listed && wallet.is_history_page_listed);
    assert_eq!(inspection.unqueued_signatures, 0);
    assert_eq!(inspection.fetched_without_payload, 0);
    assert_eq!(inspection.stored_but_queued, 0);
    assert_eq!(inspection.unreturned_transactions, 0);
}

#[tokio::test]
async fn counts_the_listed_signatures_again_when_the_counter_drifted() {
    let (_folder, store) = listed_store().await;
    break_by_hand(
        &store,
        "UPDATE wallet_cursor SET listed_count = 7 WHERE ?1 <> ''",
        0,
    )
    .await;
    assert_eq!(inspect(&store).await.wallets[0].counted, 7);

    store.consistency().recount_listed(WALLET).await.unwrap();

    assert_eq!(inspect(&store).await.wallets[0].counted, 2);
}

#[tokio::test]
async fn notices_a_cursor_that_points_at_signatures_the_wallet_does_not_list() {
    let (_folder, store) = listed_store().await;

    break_by_hand(
        &store,
        "DELETE FROM wallet_signature WHERE signature = ?1",
        2,
    )
    .await;
    break_by_hand(
        &store,
        "DELETE FROM wallet_signature WHERE signature = ?1",
        3,
    )
    .await;

    let wallet = inspect(&store).await.wallets[0];
    assert!(!wallet.is_top_listed);
    assert!(!wallet.is_history_page_listed);
}

#[tokio::test]
async fn queues_listed_signatures_without_a_task_and_never_queues_a_stored_one() {
    let (_folder, store) = listed_store().await;
    store_transaction(&store, 2).await;
    break_by_hand(&store, "DELETE FROM tx_fetch WHERE signature = ?1", 2).await;
    break_by_hand(&store, "DELETE FROM tx_fetch WHERE signature = ?1", 3).await;
    assert_eq!(inspect(&store).await.unqueued_signatures, 2);

    let queued = store
        .consistency()
        .queue_unqueued_signatures(Priority::CatchUp, later(5))
        .await
        .unwrap();

    assert_eq!(queued, 1);
    let due = store
        .fetch_queue()
        .due(later(5), 10, Priority::History)
        .await
        .unwrap();
    let due: Vec<_> = due
        .iter()
        .map(|task| (task.signature, task.priority))
        .collect();
    assert_eq!(due, [(listed(3, 10).signature, Priority::CatchUp)]);
    let counts = store.fetch_queue().counts(WALLET).await.unwrap();
    assert_eq!((counts.fetched, counts.pending), (1, 1));
    assert_eq!(inspect(&store).await.unqueued_signatures, 0);
}

#[tokio::test]
async fn marks_fetched_an_open_task_whose_transaction_is_stored() {
    let (_folder, store) = listed_store().await;
    store_transaction(&store, 3).await;
    assert_eq!(inspect(&store).await.stored_but_queued, 1);

    let marked = store
        .consistency()
        .mark_stored_fetched(later(5))
        .await
        .unwrap();

    assert_eq!(marked, 1);
    let due = store
        .fetch_queue()
        .due(later(5), 10, Priority::History)
        .await
        .unwrap();
    assert_eq!(due.len(), 1);
    assert_eq!(due[0].signature, listed(2, 20).signature);
    assert_eq!(inspect(&store).await.stored_but_queued, 0);
}

#[tokio::test]
async fn queues_again_a_task_marked_fetched_without_its_transaction() {
    let (_folder, store) = listed_store().await;
    break_by_hand(
        &store,
        "UPDATE tx_fetch SET state = 'fetched', next_attempt_at = NULL WHERE signature = ?1",
        2,
    )
    .await;
    assert_eq!(inspect(&store).await.fetched_without_payload, 1);

    let queued = store
        .consistency()
        .requeue_fetched_without_payload(Priority::CatchUp, later(5))
        .await
        .unwrap();

    assert_eq!(queued, 1);
    let due = store
        .fetch_queue()
        .due(later(5), 10, Priority::CatchUp)
        .await
        .unwrap();
    assert_eq!(due.len(), 1);
    assert_eq!(due[0].signature, listed(2, 20).signature);
}

#[tokio::test]
async fn counts_unreturned_transactions_and_outdated_or_unordered_decodes() {
    let (_folder, store) = listed_store().await;
    break_by_hand(
        &store,
        "UPDATE tx_fetch SET state = 'empty_retry' WHERE signature = ?1",
        2,
    )
    .await;
    for seed in [7, 8, 9] {
        store_transaction(&store, seed).await;
    }
    let decode = |seed: u8, reader_version: u32, transaction_index: Option<u32>| DecodeRecord {
        signature: Signature::from_bytes([seed; 64]),
        decoder: "dlmm".to_owned(),
        decoder_version: 2,
        reader_version,
        execution_outcome: None,
        transaction_index,
        outcome: DecodeOutcome::NotApplicable,
        decoded_at: listed_at(),
    };
    let decoded = store.decoded();
    decoded
        .replace_for_signature(decode(7, 1, Some(4)))
        .await
        .unwrap();
    decoded
        .replace_for_signature(decode(8, 1, None))
        .await
        .unwrap();
    decoded
        .replace_for_signature(decode(9, 0, None))
        .await
        .unwrap();

    let inspection = inspect(&store).await;

    assert_eq!(inspection.unreturned_transactions, 1);
    assert_eq!(inspection.outdated_decodes, 1);
    assert_eq!(inspection.unordered_transactions, 1);
}
