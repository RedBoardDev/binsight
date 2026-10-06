//! Startup replay, wake-ups after a fetch and isolated failures, without spending RPC credits.

use super::*;
use crate::test_support::{TEST_START, temporary_engine};
use binsight_solana::{
    Commitment,
    transaction::{TxEncoding, read},
};
use binsight_store::{DecodeOutcome, DecodeRecord, FetchedTx, RawTxRecord, Store};
use jiff::Timestamp;

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
    let ingestion = Ingestion::on_test_engine(&setup);
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
    decode_new(&ingestion, &mut RegistryPosition::default())
        .await
        .unwrap();
    let upgraded = wait_for_decode(&setup.store, raw.signature).await;
    assert!(matches!(
        upgraded.execution_outcome,
        Some(binsight_solana::transaction::TxOutcome::Failed { .. })
    ));
    decode_new(&ingestion, &mut RegistryPosition::default())
        .await
        .unwrap();
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
async fn decodes_a_transaction_fetched_later_when_woken_without_polling_or_refetching() {
    let setup = temporary_engine().await;
    let ingestion = Ingestion::on_test_engine(&setup);
    let [first, later] = [fetched("legacy-sol-transfer"), fetched("failed-close")];
    setup
        .store
        .fetch_queue()
        .complete(first.clone())
        .await
        .unwrap();
    let shutdown = CancellationToken::new();
    let worker = tokio::spawn({
        let ingestion = ingestion.clone();
        let shutdown = shutdown.clone();
        async move { run_decoder(&ingestion, &shutdown).await }
    });
    wait_for_decode(&setup.store, first.signature).await;
    setup
        .store
        .fetch_queue()
        .complete(later.clone())
        .await
        .unwrap();
    ingestion.new_raw.notify_one();
    wait_for_decode(&setup.store, later.signature).await;
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
    let ingestion = Ingestion::on_test_engine(&setup);
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
    decode_new(&ingestion, &mut RegistryPosition::default())
        .await
        .unwrap();
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

fn panicking_decoder(_raw: &RawTxRecord, _decoded_at: Timestamp) -> DecodeRecord {
    panic!("a payload the decoder cannot handle")
}

#[tokio::test]
async fn records_a_decoder_panic_as_the_failed_result_of_that_transaction_only() {
    let setup = temporary_engine().await;
    let raw = fetched("failed-close");
    setup
        .store
        .fetch_queue()
        .complete(raw.clone())
        .await
        .unwrap();
    let stored = setup
        .store
        .raw_tx()
        .get(raw.signature)
        .await
        .unwrap()
        .unwrap();

    let record = decode_isolated(stored, TEST_START, panicking_decoder).await;

    assert_eq!(record.signature, raw.signature);
    assert_eq!(record.decoder_version, DECODER_VERSION);
    assert_eq!(record.execution_outcome, None);
    assert!(matches!(record.outcome, DecodeOutcome::Failed { .. }));
}
