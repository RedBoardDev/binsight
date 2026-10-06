//! Suspended top-ups preserve their join and yield between pages.

use super::*;
use crate::ingestion::{IngestionParts, SyncPublisher};
use crate::test_support::{TEST_START, complete_history, numbered_signature, signature_page};
use binsight_chain::test_support::{ScriptedConnector, scripted_client};
use binsight_chain::{RpcClient, StreamEvent, WalletStream};
use binsight_core::clock::FixedClock;
use binsight_core::credits::Credits;
use serde_json::json;
use std::sync::Arc;
use tokio::sync::{broadcast, watch};

const WALLET: Address = Address::from_bytes([1; 32]);
const OTHER: Address = Address::from_bytes([2; 32]);

fn ingestion(
    store: binsight_store::Store,
    rpc: RpcClient,
    clock: Arc<FixedClock>,
    wallets: &[Address],
) -> Ingestion {
    let (_, wallet_watch, _) = WalletStream::new(ScriptedConnector::new(), rpc.clone());
    let (states, _) = watch::channel(BTreeMap::new());
    let (events, _) = broadcast::channel(16);
    let ingestion = Ingestion::new(IngestionParts {
        store,
        rpc,
        clock,
        watch: wallet_watch,
        sync: SyncPublisher { states, events },
    });
    for wallet in wallets {
        ingestion
            .live
            .apply(&StreamEvent::Subscribed { wallet: *wallet }, TEST_START);
    }
    ingestion
}

fn page_params(wallet: Address, before: Option<u16>) -> serde_json::Value {
    let mut options = json!({"limit":1_000,"commitment":"finalized","until":numbered_signature(2_000).to_string()});
    if let Some(before) = before {
        options["before"] = json!(numbered_signature(before).to_string());
    }
    json!([wallet.to_string(), options])
}

#[tokio::test(start_paused = true)]
async fn resumes_the_same_top_up_page_after_a_budget_pause() {
    let setup = complete_history(&[WALLET], 2_000).await;
    let clock = Arc::new(FixedClock::new(TEST_START));
    let rpc = scripted_client(setup.transport.clone(), clock.clone(), Some(Credits(1)));
    setup
        .transport
        .expect("getSignaturesForAddress")
        .with_params(page_params(WALLET, None))
        .respond(signature_page(0, 1_000));
    setup
        .transport
        .expect("getSignaturesForAddress")
        .with_params(page_params(WALLET, Some(999)))
        .respond(signature_page(1_000, 1));
    let ingestion = ingestion(setup.store.clone(), rpc, clock.clone(), &[WALLET]);
    let mut worker = ListingWorker::default();
    assert!(matches!(worker.step(&ingestion).await, Progress::Continue));
    assert!(matches!(
        worker.step(&ingestion).await,
        Progress::Wait(Some(_))
    ));
    ingestion.live.apply(
        &StreamEvent::Activity(binsight_chain::Activity {
            wallet: WALLET,
            signature: numbered_signature(10_000),
            slot: 200_000,
            is_failed: false,
        }),
        TEST_START,
    );
    assert!(matches!(
        worker.step(&ingestion).await,
        Progress::Wait(Some(_))
    ));
    assert_eq!(setup.transport.calls().len(), 1);
    clock.advance(jiff::SignedDuration::from_hours(24)).unwrap();
    assert!(matches!(worker.step(&ingestion).await, Progress::Continue));
    assert_eq!(setup.transport.calls().len(), 2);
    assert!(worker.top_ups.is_empty());
}

#[tokio::test(start_paused = true)]
async fn checks_another_wallet_between_top_up_pages_without_raising_the_top_early() {
    let setup = complete_history(&[WALLET, OTHER], 2_000).await;
    let clock = Arc::new(FixedClock::new(TEST_START));
    let rpc = scripted_client(setup.transport.clone(), clock.clone(), None);
    setup
        .transport
        .expect("getSignaturesForAddress")
        .with_params(page_params(WALLET, None))
        .respond(signature_page(0, 1_000));
    setup
        .transport
        .expect("getSignaturesForAddress")
        .with_params(page_params(OTHER, None))
        .respond(signature_page(2_000, 0));
    setup
        .transport
        .expect("getSignaturesForAddress")
        .with_params(page_params(WALLET, Some(999)))
        .respond(signature_page(1_000, 1));
    let ingestion = ingestion(setup.store.clone(), rpc, clock, &[WALLET, OTHER]);
    let mut worker = ListingWorker::default();
    worker.step(&ingestion).await;
    worker.step(&ingestion).await;
    let tracked = setup.store.wallets().list().await.unwrap();
    assert!(
        matches!(tracked.iter().find(|wallet| wallet.address == WALLET).unwrap().cursor,
            binsight_store::WalletCursor::HistoryComplete { top: Some(top) } if top.signature == numbered_signature(2_000))
    );
    worker.step(&ingestion).await;
    let calls = setup.transport.calls();
    assert_eq!(
        calls
            .iter()
            .map(|call| call.params[0].clone())
            .collect::<Vec<_>>(),
        vec![
            json!(WALLET.to_string()),
            json!(OTHER.to_string()),
            json!(WALLET.to_string())
        ]
    );
}

#[tokio::test(start_paused = true)]
async fn another_wallet_imports_while_a_top_up_waits_for_its_network_retry() {
    use binsight_chain::test_support::ScriptedReply;
    use binsight_core::clock::Clock;
    let setup = complete_history(&[WALLET], 2_000).await;
    setup.store.wallets().add(OTHER, TEST_START).await.unwrap();
    let clock = Arc::new(FixedClock::new(TEST_START));
    let rpc = scripted_client(setup.transport.clone(), clock.clone(), None);
    for _ in 0..4 {
        setup
            .transport
            .expect("getSignaturesForAddress")
            .with_params(page_params(WALLET, None))
            .respond(ScriptedReply::Http {
                status: 503,
                retry_after: None,
                body: "unavailable".to_owned(),
            });
    }
    setup
        .transport
        .expect("getSignaturesForAddress")
        .with_params(json!([OTHER.to_string(), {"limit":1_000,"commitment":"finalized"}]))
        .respond(signature_page(0, 1_000));
    setup.transport.expect("getSignaturesForAddress")
        .with_params(json!([OTHER.to_string(), {"limit":1_000,"commitment":"finalized","before":numbered_signature(999).to_string()}]))
        .respond(signature_page(1_000, 1_000));
    let ingestion = ingestion(setup.store.clone(), rpc, clock.clone(), &[WALLET, OTHER]);
    let mut worker = ListingWorker::default();
    worker.step(&ingestion).await;
    let retry_at = worker.top_ups[&WALLET].retry_at.unwrap();
    assert!(retry_at > TEST_START);
    for expected_listed in [1_000, 2_000] {
        assert!(matches!(worker.step(&ingestion).await, Progress::Continue));
        assert_eq!(
            setup
                .store
                .fetch_queue()
                .counts(OTHER)
                .await
                .unwrap()
                .listed,
            expected_listed
        );
        assert_eq!(worker.top_ups[&WALLET].retry_at, Some(retry_at));
        assert_eq!(clock.now(), TEST_START);
    }
    assert_eq!(setup.transport.calls().len(), 6);
}
