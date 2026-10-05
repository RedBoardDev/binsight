//! Startup replay and live wake-ups derive results without spending RPC credits.

use super::*;
use crate::ingestion::SyncPublisher;
use crate::test_support::{TEST_START, temporary_engine};
use binsight_chain::WalletStream;
use binsight_chain::test_support::{ScriptedConnector, scripted_client};
use binsight_core::clock::FixedClock;
use binsight_solana::{
    Commitment,
    transaction::{TxEncoding, read},
};
use binsight_store::{DecodeOutcome, DecodeRecord, FetchedTx, Store};
use jiff::Timestamp;
use std::collections::BTreeMap;
use std::sync::Arc;
use tokio::sync::{broadcast, watch};

fn fetched(name: &str) -> FetchedTx {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../tests/fixtures/mainnet")
        .join(name)
        .join("tx-1.json");
    let payload = std::fs::read(path).unwrap();
    let tx = read(&payload).unwrap();
    FetchedTx {
        signature: tx.signature,
        slot: tx.slot,
        block_time: tx.block_time,
        tx_version: tx.version,
        commitment: Commitment::Finalized,
        encoding: TxEncoding::Base64,
        payload,
        fetched_at: TEST_START,
    }
}

async fn wait_for_decode(store: &Store, signature: Signature) -> DecodeRecord {
    tokio::time::timeout(Duration::from_secs(3_600), async {
        loop {
            if let Some(record) = store
                .decoded()
                .get(signature, DECODER_NAME.to_owned())
                .await
                .unwrap()
                && record.decoder_version == DECODER_VERSION
            {
                return record;
            }
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
    })
    .await
    .unwrap()
}

#[tokio::test(start_paused = true)]
async fn upgrades_old_and_failed_results_offline_and_keeps_current_results_unchanged() {
    let setup = temporary_engine().await;
    let clock = Arc::new(FixedClock::new(TEST_START));
    let rpc = scripted_client(setup.transport.clone(), clock.clone(), None);
    let (_, watch_wallets, _) = WalletStream::new(ScriptedConnector::new(), rpc.clone());
    let (states, _) = watch::channel(BTreeMap::new());
    let (events, _) = broadcast::channel(16);
    let ingestion = Ingestion::new(
        setup.store.clone(),
        rpc,
        clock,
        (watch_wallets, SyncPublisher { states, events }),
    );
    let raw = fetched("failed-close");
    setup
        .store
        .fetch_queue()
        .complete(raw.clone())
        .await
        .unwrap();
    setup
        .store
        .decoded()
        .replace_for_signature(DecodeRecord {
            signature: raw.signature,
            decoder: DECODER_NAME.to_owned(),
            decoder_version: 1,
            execution_outcome: None,
            outcome: DecodeOutcome::Failed {
                error: "old decoder".to_owned(),
            },
            decoded_at: Timestamp::UNIX_EPOCH,
        })
        .await
        .unwrap();
    drain_registry(&ingestion).await.unwrap();
    let upgraded = wait_for_decode(&setup.store, raw.signature).await;
    assert!(matches!(
        upgraded.execution_outcome,
        Some(binsight_solana::transaction::TxOutcome::Failed { .. })
    ));
    drain_registry(&ingestion).await.unwrap();
    assert_eq!(
        setup
            .store
            .decoded()
            .get(raw.signature, DECODER_NAME.to_owned())
            .await
            .unwrap(),
        Some(upgraded)
    );
    assert_eq!(
        setup.store.raw_tx().payload(raw.signature).await.unwrap(),
        Some(raw.payload)
    );
    assert_eq!(setup.transport.calls(), Vec::new());
}

#[tokio::test(start_paused = true)]
async fn wakes_for_a_new_signature_before_the_previous_cursor_without_polling_or_refetching() {
    let setup = temporary_engine().await;
    let clock = Arc::new(FixedClock::new(TEST_START));
    let rpc = scripted_client(setup.transport.clone(), clock.clone(), None);
    let (_, watch_wallets, _) = WalletStream::new(ScriptedConnector::new(), rpc.clone());
    let (states, _) = watch::channel(BTreeMap::new());
    let (events, _) = broadcast::channel(16);
    let ingestion = Ingestion::new(
        setup.store.clone(),
        rpc,
        clock,
        (watch_wallets, SyncPublisher { states, events }),
    );
    let mut raws = [fetched("failed-close"), fetched("legacy-sol-transfer")];
    raws.sort_by_key(|raw| raw.signature.to_string());
    let [earlier, later] = raws;
    setup
        .store
        .fetch_queue()
        .complete(later.clone())
        .await
        .unwrap();
    let shutdown = CancellationToken::new();
    let worker = tokio::spawn({
        let ingestion = ingestion.clone();
        let shutdown = shutdown.clone();
        async move { run_decoder(&ingestion, &shutdown).await }
    });
    wait_for_decode(&setup.store, later.signature).await;
    setup
        .store
        .fetch_queue()
        .complete(earlier.clone())
        .await
        .unwrap();
    ingestion.new_raw.notify_one();
    wait_for_decode(&setup.store, earlier.signature).await;
    assert_eq!(setup.transport.calls(), Vec::new());
    shutdown.cancel();
    worker.await.unwrap();
}

#[tokio::test(start_paused = true)]
async fn startup_replay_survives_a_restart_without_refetching_or_replacing_current_results() {
    use crate::test_support::{RunningEngine, reopened_engine};
    let setup = temporary_engine().await;
    let raw = fetched("failed-close");
    setup
        .store
        .fetch_queue()
        .complete(raw.clone())
        .await
        .unwrap();
    let engine = RunningEngine::start(setup);
    let decoded = wait_for_decode(&engine.store, raw.signature).await;
    assert_eq!(engine.transport.calls(), Vec::new());
    let folder = engine.stop().await;
    let setup = reopened_engine(folder).await;
    let engine = RunningEngine::start(setup);
    let replay = wait_for_decode(&engine.store, raw.signature).await;
    assert_eq!(decoded, replay);
    assert_eq!(
        engine.store.raw_tx().payload(raw.signature).await.unwrap(),
        Some(raw.payload)
    );
    assert_eq!(engine.transport.calls(), Vec::new());
    engine.stop().await;
}

#[tokio::test(start_paused = true)]
async fn records_a_damaged_payload_as_unknown_execution_and_continues_the_registry_scan() {
    let setup = temporary_engine().await;
    let clock = Arc::new(FixedClock::new(TEST_START));
    let rpc = scripted_client(setup.transport.clone(), clock.clone(), None);
    let (_, watch_wallets, _) = WalletStream::new(ScriptedConnector::new(), rpc.clone());
    let (states, _) = watch::channel(BTreeMap::new());
    let (events, _) = broadcast::channel(16);
    let ingestion = Ingestion::new(
        setup.store.clone(),
        rpc,
        clock,
        (watch_wallets, SyncPublisher { states, events }),
    );
    let valid = fetched("failed-close");
    let damaged = binsight_store::RawTxRecord {
        signature: Signature::from_bytes([0; 64]),
        slot: valid.slot,
        block_time: valid.block_time,
        tx_version: valid.tx_version,
        commitment: valid.commitment,
        encoding: valid.encoding,
        compression: binsight_store::PayloadCompression::None,
        payload: valid.payload.clone(),
        payload_sha256: [0; 32],
        fetched_at: TEST_START,
    };
    setup
        .store
        .raw_tx()
        .insert_if_absent(damaged.clone())
        .await
        .unwrap();
    setup
        .store
        .fetch_queue()
        .complete(valid.clone())
        .await
        .unwrap();
    drain_registry(&ingestion).await.unwrap();
    let rejected = wait_for_decode(&setup.store, damaged.signature).await;
    assert_eq!(rejected.execution_outcome, None);
    assert!(matches!(rejected.outcome, DecodeOutcome::Failed { .. }));
    assert!(matches!(
        wait_for_decode(&setup.store, valid.signature)
            .await
            .execution_outcome,
        Some(binsight_solana::transaction::TxOutcome::Failed { .. })
    ));
    assert!(matches!(
        setup.store.raw_tx().payload(damaged.signature).await,
        Err(StoreError::PayloadChecksumMismatch)
    ));
    assert_eq!(setup.transport.calls(), Vec::new());
}
