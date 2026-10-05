//! Real SQLite captures keep owned metadata stable across concurrent prefix insertion.

use super::*;
use crate::database::test_database::assert_queries_prepare;
use crate::ingestion::test_pages::{
    WALLET, history_page, listed, listed_at, page_after, store_with_wallet,
};

#[tokio::test]
async fn prepares_the_wallet_metadata_snapshot_query() {
    assert_queries_prepare(&[SELECT_SNAPSHOT]).await;
}

#[tokio::test]
async fn keeps_wallet_scope_and_missing_raw_dates_or_ranks_without_inventing_coverage() {
    let (_folder, store) = store_with_wallet().await;
    let other = Address::from_bytes([9; 32]);
    store.wallets().add(other, listed_at()).await.unwrap();
    assert_eq!(
        store.signatures().metadata_snapshot(WALLET).await.unwrap(),
        Vec::new()
    );
    let unknown = ListedSignature {
        slot_order: None,
        block_time: None,
        is_failed: true,
        ..listed(2, 30)
    };
    let mut expected = vec![listed(3, 10), listed(1, 50), unknown];
    let records = store.signatures();
    records
        .record_listing(history_page(WALLET, expected.clone()))
        .await
        .unwrap();
    let shared = listed(2, 30);
    records
        .record_listing(history_page(other, vec![shared]))
        .await
        .unwrap();
    expected.sort_by_key(|row| row.signature.to_string());
    assert_eq!(records.metadata_snapshot(WALLET).await.unwrap(), expected);
    assert_eq!(
        records.metadata_snapshot(other).await.unwrap(),
        vec![shared]
    );
    for row in expected {
        assert!(store.raw_tx().get(row.signature).await.unwrap().is_none());
    }
    assert_eq!(
        records
            .metadata_snapshot(Address::from_bytes([8; 32]))
            .await
            .unwrap(),
        Vec::new()
    );
}

#[tokio::test]
async fn retains_owned_rows_after_a_later_listing_shifts_their_slot_ranks() {
    let (_folder, store) = store_with_wallet().await;
    let records = store.signatures();
    let page = history_page(WALLET, vec![listed(1, 20)]);
    records.record_listing(page.clone()).await.unwrap();
    let original = records.metadata_snapshot(WALLET).await.unwrap();
    records
        .record_listing(page_after(&page, vec![listed(2, 20)]))
        .await
        .unwrap();
    assert_eq!(original, vec![listed(1, 20)]);
    let updated = records.metadata_snapshot(WALLET).await.unwrap();
    assert_eq!(updated.len(), 2);
    assert_eq!(
        updated
            .iter()
            .find(|row| row.signature == listed(1, 20).signature)
            .unwrap()
            .slot_order,
        Some(1)
    );
}

#[tokio::test]
async fn freezes_all_rows_before_a_concurrent_writer_inserts_a_same_slot_prefix() {
    let (_folder, store) = store_with_wallet().await;
    let records = store.signatures();
    let page = history_page(WALLET, vec![listed(1, 20)]);
    records.record_listing(page.clone()).await.unwrap();
    let (started, ready) = tokio::sync::oneshot::channel();
    let (committed, proceed) = tokio::sync::oneshot::channel();
    let reader = records.database.clone();
    let reading = tokio::spawn(async move {
        reader
            .read(move |connection| {
                read_snapshot(connection, |snapshot| {
                    // Establish the same production read transaction, then let ingestion commit.
                    let _: i64 = snapshot.query_row(
                        "SELECT count(*) FROM wallet_signature WHERE wallet = ?1",
                        params![WALLET.to_string()],
                        |row| row.get(0),
                    )?;
                    started.send(()).unwrap();
                    proceed.blocking_recv().unwrap();
                    read_listed(snapshot, WALLET)
                })
            })
            .await
            .unwrap()
    });
    ready.await.unwrap();
    records
        .record_listing(page_after(&page, vec![listed(2, 20)]))
        .await
        .unwrap();
    committed.send(()).unwrap();
    assert_eq!(reading.await.unwrap(), vec![listed(1, 20)]);
    assert_eq!(records.metadata_snapshot(WALLET).await.unwrap().len(), 2);
}

#[tokio::test]
async fn refuses_an_invalid_signature_without_silently_omitting_its_metadata() {
    let (_folder, store) = store_with_wallet().await;
    let records = store.signatures();
    records
        .record_listing(history_page(WALLET, vec![listed(1, 20)]))
        .await
        .unwrap();
    records
        .database
        .write(|connection| {
            connection.execute("UPDATE wallet_signature SET signature = '!'", [])?;
            Ok(())
        })
        .await
        .unwrap();
    assert!(matches!(
        records.metadata_snapshot(WALLET).await,
        Err(StoreError::InvalidStoredValue {
            what: "listed signature",
            ..
        })
    ));
}
