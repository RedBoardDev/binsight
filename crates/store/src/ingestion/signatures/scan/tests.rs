//! Listed pages keep wallet scope, nullable metadata and holes in the raw registry explicit.

use super::*;
use crate::database::test_database::assert_queries_prepare;
use crate::ingestion::test_pages::{
    WALLET, history_page, listed, listed_at, page_after, store_with_wallet,
};

fn scan(wallet: Address) -> WalletSignatureScan {
    WalletSignatureScan {
        wallet,
        after: None,
        limit: 2,
    }
}

#[tokio::test]
async fn prepares_the_bounded_wallet_metadata_query() {
    assert_queries_prepare(&[SELECT_LISTED]).await;
}

#[tokio::test]
async fn keeps_wallet_scope_and_missing_raw_or_optional_metadata_in_bounded_pages() {
    let (_folder, store) = store_with_wallet().await;
    let other = Address::from_bytes([9; 32]);
    store.wallets().add(other, listed_at()).await.unwrap();
    let unknown = ListedSignature {
        slot_order: None,
        block_time: None,
        is_failed: true,
        ..listed(2, 30)
    };
    let mut expected = vec![listed(3, 10), listed(1, 50), unknown];
    store
        .signatures()
        .record_listing(history_page(WALLET, expected.clone()))
        .await
        .unwrap();
    let shared = listed(2, 30);
    store
        .signatures()
        .record_listing(history_page(other, vec![shared]))
        .await
        .unwrap();
    expected.sort_by_key(|row| row.signature.to_string());
    let first = store.signatures().scan(scan(WALLET)).await.unwrap();
    assert_eq!(first, expected[..2]);
    let second = store
        .signatures()
        .scan(WalletSignatureScan {
            after: first.last().map(|row| row.signature),
            ..scan(WALLET)
        })
        .await
        .unwrap();
    assert_eq!(second, expected[2..]);
    assert_eq!(
        store.signatures().scan(scan(other)).await.unwrap(),
        vec![shared]
    );
    for row in first.iter().chain(&second) {
        assert!(store.raw_tx().get(row.signature).await.unwrap().is_none());
    }
    assert!(first.iter().chain(&second).any(|row| *row == unknown));
}

#[tokio::test]
async fn resumes_without_duplicates_and_restarts_to_find_additions_before_the_cursor() {
    let (_folder, store) = store_with_wallet().await;
    let page = history_page(
        WALLET,
        (1..=5).map(|seed| listed(seed, u64::from(seed))).collect(),
    );
    let mut expected = page.signatures.clone();
    expected.sort_by_key(|row| row.signature.to_string());
    store
        .signatures()
        .record_listing(page.clone())
        .await
        .unwrap();
    let mut request = scan(WALLET);
    let mut observed = Vec::new();
    loop {
        let batch = store.signatures().scan(request).await.unwrap();
        if batch.is_empty() {
            break;
        }
        assert!(batch.len() <= usize::from(request.limit));
        request.after = batch.last().map(|row| row.signature);
        observed.extend(batch);
    }
    assert_eq!(observed, expected);
    let before = listed(0, 100);
    assert!(before.signature.to_string() < expected[0].signature.to_string());
    store
        .signatures()
        .record_listing(page_after(&page, vec![before]))
        .await
        .unwrap();
    assert_eq!(store.signatures().scan(request).await.unwrap(), Vec::new());
    assert_eq!(
        store.signatures().scan(scan(WALLET)).await.unwrap()[0],
        before
    );
}

#[tokio::test]
async fn returns_empty_for_a_zero_limit_or_a_wallet_without_listed_signatures() {
    let (_folder, store) = store_with_wallet().await;
    store
        .signatures()
        .record_listing(history_page(WALLET, vec![listed(1, 10)]))
        .await
        .unwrap();
    assert_eq!(
        store
            .signatures()
            .scan(WalletSignatureScan {
                limit: 0,
                ..scan(WALLET)
            })
            .await
            .unwrap(),
        Vec::new()
    );
    assert_eq!(
        store
            .signatures()
            .scan(scan(Address::from_bytes([8; 32])))
            .await
            .unwrap(),
        Vec::new()
    );
}

#[tokio::test]
async fn refuses_a_malformed_stored_signature_instead_of_dropping_its_row() {
    let (_folder, store) = store_with_wallet().await;
    let records = store.signatures();
    records
        .record_listing(history_page(WALLET, vec![listed(1, 10)]))
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
        records.scan(scan(WALLET)).await,
        Err(StoreError::InvalidStoredValue {
            what: "listed signature",
            ..
        })
    ));
}
