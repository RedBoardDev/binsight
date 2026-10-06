//! Finalized fetches wake the decoder; retryable responses leave it asleep.

use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Duration;

use binsight_chain::WalletStream;
use binsight_chain::test_support::{ScriptedConnector, ScriptedReply, scripted_client};
use binsight_core::clock::FixedClock;
use binsight_solana::{Address, transaction::read};
use binsight_store::{ListedSignature, ListedTop, ListingPage, Store, WalletCursor};
use tokio::sync::{broadcast, watch};

use super::*;
use crate::ingestion::{IngestionParts, SyncPublisher};
use crate::test_support::{TEST_START, temporary_engine};

const WALLET: Address = Address::from_bytes([1; 32]);

fn ingestion(
    store: Store,
    transport: Arc<binsight_chain::test_support::ScriptedTransport>,
) -> Ingestion {
    let clock = Arc::new(FixedClock::new(TEST_START));
    let rpc = scripted_client(transport, clock.clone(), None);
    let (_, wallets, _) = WalletStream::new(ScriptedConnector::new(), rpc.clone());
    let (states, _) = watch::channel(BTreeMap::new());
    let (events, _) = broadcast::channel(16);
    Ingestion::new(IngestionParts {
        store,
        rpc,
        clock,
        watch: wallets,
        sync: SyncPublisher { states, events },
    })
}

fn failed_close() -> Vec<u8> {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../tests/fixtures/mainnet/failed-close/tx-1.json");
    std::fs::read(path).unwrap()
}

async fn queue(store: &Store, payload: &[u8]) -> FetchTask {
    let transaction = read(payload).unwrap();
    store.wallets().add(WALLET, TEST_START).await.unwrap();
    store
        .signatures()
        .record_listing(ListingPage {
            wallet: WALLET,
            signatures: vec![ListedSignature {
                signature: transaction.signature,
                slot: transaction.slot,
                block_time: transaction.block_time,
                is_failed: true,
            }],
            previous_cursor: WalletCursor::NotStarted,
            cursor: WalletCursor::HistoryComplete {
                top: Some(ListedTop {
                    signature: transaction.signature,
                    slot: transaction.slot,
                }),
            },
            fetch_priority: Priority::History,
            listed_at: TEST_START,
        })
        .await
        .unwrap();
    FetchTask {
        signature: transaction.signature,
        slot: transaction.slot,
        priority: Priority::History,
        attempts: 0,
    }
}

#[tokio::test(start_paused = true)]
async fn wakes_the_decoder_when_a_finalized_fetch_commits() {
    let setup = temporary_engine().await;
    let payload = failed_close();
    let task = queue(&setup.store, &payload).await;
    setup
        .transport
        .expect("getTransaction")
        .respond(ScriptedReply::Result(
            serde_json::from_slice(&payload).unwrap(),
        ));
    let ingestion = ingestion(setup.store.clone(), setup.transport.clone());
    let wake = ingestion.new_raw.notified();
    tokio::pin!(wake);
    wake.as_mut().enable();

    assert_eq!(fetch_one(ingestion.clone(), task).await, Fetched::Recorded);
    tokio::time::timeout(Duration::from_secs(1), wake)
        .await
        .unwrap();

    assert!(
        setup
            .store
            .raw_tx()
            .get(task.signature)
            .await
            .unwrap()
            .is_some()
    );
    assert_eq!(
        setup
            .store
            .fetch_queue()
            .counts(WALLET)
            .await
            .unwrap()
            .fetched,
        1
    );
    let stored = setup
        .store
        .raw_tx()
        .payload(task.signature)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(read(&stored).unwrap().signature, task.signature);
    assert_eq!(setup.transport.calls().len(), 1);
}

#[tokio::test(start_paused = true)]
async fn leaves_the_decoder_asleep_when_a_fetch_is_rescheduled() {
    let setup = temporary_engine().await;
    let task = queue(&setup.store, &failed_close()).await;
    setup
        .transport
        .expect("getTransaction")
        .respond(ScriptedReply::Null);
    let ingestion = ingestion(setup.store.clone(), setup.transport.clone());
    let wake = ingestion.new_raw.notified();
    tokio::pin!(wake);
    wake.as_mut().enable();

    assert_eq!(fetch_one(ingestion.clone(), task).await, Fetched::Recorded);
    assert!(
        tokio::time::timeout(Duration::from_secs(1), wake)
            .await
            .is_err()
    );

    assert_eq!(
        setup.store.raw_tx().get(task.signature).await.unwrap(),
        None
    );
    assert_eq!(
        setup
            .store
            .fetch_queue()
            .counts(WALLET)
            .await
            .unwrap()
            .empty_retry,
        1
    );
    assert_eq!(setup.transport.calls().len(), 1);
}
