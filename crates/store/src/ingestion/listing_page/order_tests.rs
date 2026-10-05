//! A late same-slot listing inserts an ordinal without colliding with existing ones.

use binsight_core::credits::Priority;
use binsight_solana::{Address, Signature};

use super::*;
use crate::ingestion::test_pages::{WALLET, listed, listed_at, store_with_wallet};

fn ranked(seed: u8, rank: u32) -> ListedSignature {
    ListedSignature {
        slot_order: Some(rank),
        ..listed(seed, 20)
    }
}

fn page(wallet: Address, signatures: Vec<ListedSignature>, cursor: WalletCursor) -> ListingPage {
    ListingPage {
        wallet,
        signatures,
        previous_cursor: cursor,
        cursor: WalletCursor::HistoryComplete { top: None },
        fetch_priority: Priority::History,
        listed_at: listed_at(),
    }
}

async fn ranks(store: &crate::Store, wallet: Address, seeds: &[u8]) -> Vec<Option<u32>> {
    let mut result = Vec::new();
    for seed in seeds {
        result.push(
            store
                .signatures()
                .get(wallet, Signature::from_bytes([*seed; 64]))
                .await
                .unwrap()
                .unwrap()
                .slot_order,
        );
    }
    result
}

#[tokio::test]
async fn inserts_a_same_slot_prefix_without_colliding_with_existing_ranks() {
    let (_folder, store) = store_with_wallet().await;
    let cursor = WalletCursor::HistoryComplete { top: None };
    store
        .signatures()
        .record_listing(page(
            WALLET,
            vec![ranked(1, 0), ranked(2, 1)],
            WalletCursor::NotStarted,
        ))
        .await
        .unwrap();
    store
        .signatures()
        .record_listing(page(WALLET, vec![ranked(3, 0), ranked(4, 1)], cursor))
        .await
        .unwrap();
    assert_eq!(
        ranks(&store, WALLET, &[1, 2, 3, 4]).await,
        [Some(2), Some(3), Some(0), Some(1)]
    );
}

#[tokio::test]
async fn inserts_a_late_middle_signature_without_moving_newer_ordinals() {
    let (_folder, store) = store_with_wallet().await;
    let cursor = WalletCursor::HistoryComplete { top: None };
    store
        .signatures()
        .record_listing(page(
            WALLET,
            vec![ranked(1, 0), ranked(2, 1), ranked(3, 2)],
            WalletCursor::NotStarted,
        ))
        .await
        .unwrap();
    store
        .signatures()
        .record_listing(page(WALLET, vec![ranked(4, 1)], cursor))
        .await
        .unwrap();
    assert_eq!(
        ranks(&store, WALLET, &[1, 4, 2, 3]).await,
        [Some(0), Some(1), Some(2), Some(3)]
    );
}

#[tokio::test]
async fn keeps_a_repeated_page_from_shifting_the_same_ranks_twice() {
    let (_folder, store) = store_with_wallet().await;
    let cursor = WalletCursor::HistoryComplete { top: None };
    store
        .signatures()
        .record_listing(page(
            WALLET,
            vec![ranked(1, 0), ranked(2, 1)],
            WalletCursor::NotStarted,
        ))
        .await
        .unwrap();
    let prefix = page(WALLET, vec![ranked(3, 0)], cursor);
    assert_eq!(
        store
            .signatures()
            .record_listing(prefix.clone())
            .await
            .unwrap(),
        1
    );
    assert_eq!(store.signatures().record_listing(prefix).await.unwrap(), 0);
    assert_eq!(
        ranks(&store, WALLET, &[1, 2, 3]).await,
        [Some(1), Some(2), Some(0)]
    );
}

#[tokio::test]
async fn ranks_a_stream_signature_once_and_keeps_other_wallets_and_slots_unchanged() {
    let (_folder, store) = store_with_wallet().await;
    let other = Address::from_bytes([9; 32]);
    store.wallets().add(other, listed_at()).await.unwrap();
    let cursor = WalletCursor::HistoryComplete { top: None };
    let unknown = ListedSignature {
        slot_order: None,
        ..listed(3, 20)
    };
    for wallet in [WALLET, other] {
        store
            .signatures()
            .record_listing(page(
                wallet,
                vec![ranked(1, 0), ranked(2, 1), unknown, listed(5, 19)],
                WalletCursor::NotStarted,
            ))
            .await
            .unwrap();
    }
    let ranked_page = page(WALLET, vec![ranked(3, 0)], cursor);
    assert_eq!(
        store
            .signatures()
            .record_listing(ranked_page.clone())
            .await
            .unwrap(),
        0
    );
    store
        .signatures()
        .record_listing(ranked_page)
        .await
        .unwrap();
    assert_eq!(
        ranks(&store, WALLET, &[1, 2, 3, 5]).await,
        [Some(1), Some(2), Some(0), Some(0)]
    );
    assert_eq!(
        ranks(&store, other, &[1, 2, 3, 5]).await,
        [Some(0), Some(1), None, Some(0)]
    );
    assert_eq!(store.fetch_queue().counts(WALLET).await.unwrap().listed, 4);
}

#[tokio::test]
async fn continues_a_same_slot_prefix_across_pages_and_appends_older_history() {
    let (_folder, store) = store_with_wallet().await;
    let cursor = WalletCursor::HistoryComplete { top: None };
    store
        .signatures()
        .record_listing(page(
            WALLET,
            vec![ranked(1, 0), ranked(2, 1)],
            WalletCursor::NotStarted,
        ))
        .await
        .unwrap();
    for signatures in [
        vec![ranked(3, 0)],
        vec![ranked(4, 1), ranked(5, 2)],
        vec![ranked(6, 5)],
    ] {
        store
            .signatures()
            .record_listing(page(WALLET, signatures, cursor))
            .await
            .unwrap();
    }
    assert_eq!(
        ranks(&store, WALLET, &[3, 4, 5, 1, 2, 6]).await,
        [Some(0), Some(1), Some(2), Some(3), Some(4), Some(5)]
    );
}

#[tokio::test]
async fn rolls_back_the_rank_shift_when_the_cursor_has_moved() {
    let (_folder, store) = store_with_wallet().await;
    store
        .signatures()
        .record_listing(page(WALLET, vec![ranked(1, 0)], WalletCursor::NotStarted))
        .await
        .unwrap();
    let failed = store
        .signatures()
        .record_listing(page(WALLET, vec![ranked(2, 0)], WalletCursor::NotStarted))
        .await;
    assert!(matches!(failed, Err(StoreError::CursorMoved { .. })));
    assert_eq!(ranks(&store, WALLET, &[1]).await, [Some(0)]);
    assert!(
        store
            .signatures()
            .get(WALLET, ranked(2, 0).signature)
            .await
            .unwrap()
            .is_none()
    );
    assert_eq!(store.fetch_queue().counts(WALLET).await.unwrap().listed, 1);
}

#[tokio::test]
async fn refuses_an_ordinal_overflow_without_writing_a_signature_or_cursor() {
    let (_folder, store) = store_with_wallet().await;
    let cursor = WalletCursor::HistoryComplete { top: None };
    store
        .signatures()
        .record_listing(page(
            WALLET,
            vec![ranked(1, u32::MAX)],
            WalletCursor::NotStarted,
        ))
        .await
        .unwrap();
    let failed = store
        .signatures()
        .record_listing(page(WALLET, vec![ranked(2, 0)], cursor))
        .await;
    assert!(matches!(failed, Err(StoreError::ValueTooLarge { .. })));
    assert_eq!(ranks(&store, WALLET, &[1]).await, [Some(u32::MAX)]);
    assert!(
        store
            .signatures()
            .get(WALLET, ranked(2, 0).signature)
            .await
            .unwrap()
            .is_none()
    );
    assert_eq!(store.wallets().list().await.unwrap()[0].cursor, cursor);
}

#[path = "order_tests/slots.rs"]
mod slots;
