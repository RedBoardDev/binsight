//! Finalized listing metadata supersedes confirmed observations and rejects conflicting finals.

use super::*;

#[tokio::test]
async fn replaces_confirmed_slot_and_outcome_with_the_finalized_listing_before_ranking() {
    let (_folder, store) = store_with_wallet().await;
    store
        .signatures()
        .record_detected(crate::DetectedSignature {
            wallet: WALLET,
            signature: listed(3, 19).signature,
            slot: 19,
            is_failed: true,
            detected_at: listed_at(),
            fetch_at: listed_at(),
        })
        .await
        .unwrap();
    store
        .signatures()
        .record_listing(page(
            WALLET,
            vec![ranked(1, 0), listed(2, 19)],
            WalletCursor::NotStarted,
        ))
        .await
        .unwrap();
    let cursor = WalletCursor::HistoryComplete { top: None };
    store
        .signatures()
        .record_listing(page(WALLET, vec![ranked(3, 0)], cursor))
        .await
        .unwrap();
    assert_eq!(
        store
            .signatures()
            .get(WALLET, ranked(3, 0).signature)
            .await
            .unwrap(),
        Some(ranked(3, 0))
    );
    assert_eq!(
        ranks(&store, WALLET, &[1, 2, 3]).await,
        [Some(1), Some(0), Some(0)]
    );
    let tasks = store
        .fetch_queue()
        .due(listed_at(), 10, Priority::History)
        .await
        .unwrap();
    let task = tasks
        .iter()
        .find(|task| task.signature == ranked(3, 0).signature)
        .unwrap();
    assert_eq!(task.slot, 20);
    assert_eq!(task.priority, Priority::Realtime);
}

#[tokio::test]
async fn refuses_a_conflicting_finalized_slot_without_recording_the_rest_of_the_page() {
    let (_folder, store) = store_with_wallet().await;
    store
        .signatures()
        .record_listing(page(WALLET, vec![ranked(1, 0)], WalletCursor::NotStarted))
        .await
        .unwrap();
    let cursor = WalletCursor::HistoryComplete { top: None };
    let failed = store
        .signatures()
        .record_listing(page(WALLET, vec![ranked(2, 0), listed(1, 21)], cursor))
        .await;
    assert!(matches!(
        failed,
        Err(StoreError::ListedSlotConflict {
            expected: 20,
            actual: 21
        })
    ));
    assert_eq!(ranks(&store, WALLET, &[1]).await, [Some(0)]);
    assert!(
        store
            .signatures()
            .get(WALLET, ranked(2, 0).signature)
            .await
            .unwrap()
            .is_none()
    );
}
