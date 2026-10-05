//! Execution outcome survives decoder failure, replacement and transaction rollback.

use binsight_solana::transaction::TxOutcome;

use super::{DecodeOutcome, DecodeRecord, DecodedEvent};
use crate::database::test_database::migrated_store;
use crate::raw_tx::tests::sample_record;

fn record(outcome: DecodeOutcome, execution_outcome: Option<TxOutcome>) -> DecodeRecord {
    DecodeRecord {
        signature: sample_record(31).signature,
        decoder: "dlmm".to_owned(),
        decoder_version: 1,
        execution_outcome,
        outcome,
        decoded_at: jiff::Timestamp::UNIX_EPOCH,
    }
}

fn events() -> DecodeOutcome {
    DecodeOutcome::Decoded(vec![DecodedEvent {
        kind: "dlmm.add_liquidity".to_owned(),
        payload_json: "{\"amount\":\"1\"}".to_owned(),
    }])
}

#[tokio::test]
async fn distinguishes_failed_execution_from_failed_decoding() {
    let (_folder, store) = migrated_store().await;
    store
        .raw_tx()
        .insert_if_absent(sample_record(31))
        .await
        .unwrap();
    let executed_failure = record(
        DecodeOutcome::Decoded(Vec::new()),
        Some(TxOutcome::Failed {
            error: "{\"InstructionError\":[1,\"Custom\"]}".to_owned(),
        }),
    );
    let decoder_failure = record(
        DecodeOutcome::Failed {
            error: "unsupported event".to_owned(),
        },
        Some(TxOutcome::Succeeded),
    );
    let unreadable = record(
        DecodeOutcome::Failed {
            error: "malformed payload".to_owned(),
        },
        None,
    );
    for expected in [executed_failure, decoder_failure, unreadable] {
        store
            .decoded()
            .replace_for_signature(expected.clone())
            .await
            .unwrap();
        assert_eq!(
            store
                .decoded()
                .get(expected.signature, "dlmm".to_owned())
                .await
                .unwrap(),
            Some(expected),
        );
    }
}

#[tokio::test]
async fn rolls_back_execution_outcome_and_events_when_replacement_fails() {
    let (_folder, store) = migrated_store().await;
    store
        .raw_tx()
        .insert_if_absent(sample_record(31))
        .await
        .unwrap();
    let original = record(events(), Some(TxOutcome::Succeeded));
    store
        .decoded()
        .replace_for_signature(original.clone())
        .await
        .unwrap();
    store
        .database()
        .write(|connection| {
            connection.execute_batch(
                "CREATE TRIGGER reject_replacement BEFORE INSERT ON decoded_event
             BEGIN SELECT RAISE(ABORT, 'replacement refused'); END;",
            )?;
            Ok(())
        })
        .await
        .unwrap();
    let replacement = record(
        events(),
        Some(TxOutcome::Failed {
            error: "transaction reverted".to_owned(),
        }),
    );
    assert!(
        store
            .decoded()
            .replace_for_signature(replacement)
            .await
            .is_err()
    );
    assert_eq!(
        store
            .decoded()
            .get(original.signature, "dlmm".to_owned())
            .await
            .unwrap(),
        Some(original),
    );
}

#[tokio::test]
async fn rejects_execution_errors_without_failed_execution_even_when_status_is_null() {
    let (_folder, store) = migrated_store().await;
    store
        .raw_tx()
        .insert_if_absent(sample_record(31))
        .await
        .unwrap();
    let signature = sample_record(31).signature.to_string();
    let accepted = store
        .database()
        .write(move |connection| {
            let mut accepted = Vec::new();
            for (outcome, error) in [
                (None, Some("orphan error")),
                (Some("succeeded"), Some("unexpected error")),
                (Some("failed"), None),
                (Some("invalid"), None),
            ] {
                accepted.push(
                    connection
                        .execute(
                            "INSERT INTO tx_decode
                 (signature, decoder, decoder_version, outcome, decoded_at,
                  execution_outcome, execution_error)
                 VALUES (?1, 'dlmm', 1, 'not_applicable', 0, ?2, ?3)",
                            rusqlite::params![signature, outcome, error],
                        )
                        .is_ok(),
                );
            }
            Ok(accepted)
        })
        .await
        .unwrap();
    assert_eq!(accepted, vec![false; 4]);
}

#[tokio::test]
async fn keeps_execution_and_events_in_one_snapshot_during_a_concurrent_replacement() {
    let (_folder, store) = migrated_store().await;
    store
        .raw_tx()
        .insert_if_absent(sample_record(31))
        .await
        .unwrap();
    let original = record(events(), Some(TxOutcome::Succeeded));
    store
        .decoded()
        .replace_for_signature(original.clone())
        .await
        .unwrap();
    let (started, ready) = tokio::sync::oneshot::channel();
    let (committed, proceed) = tokio::sync::oneshot::channel();
    let reader = store.database().clone();
    let signature = original.signature;
    let reading = tokio::spawn(async move {
        reader
            .read(move |connection| {
                super::statements::read_snapshot(connection, |snapshot| {
                    // Pause after metadata so a writer commits before the events are read.
                    let _: i64 = snapshot.query_row(
                        super::statements::SELECT_DECODE,
                        rusqlite::params![signature.to_string(), "dlmm"],
                        |row| row.get(0),
                    )?;
                    started.send(()).unwrap();
                    proceed.blocking_recv().unwrap();
                    super::statements::read_record(snapshot, signature, "dlmm".to_owned())
                })
            })
            .await
            .unwrap()
    });
    ready.await.unwrap();
    let replacement = record(
        DecodeOutcome::Decoded(Vec::new()),
        Some(TxOutcome::Failed {
            error: "execution reverted".to_owned(),
        }),
    );
    store
        .decoded()
        .replace_for_signature(replacement.clone())
        .await
        .unwrap();
    committed.send(()).unwrap();
    assert_eq!(reading.await.unwrap(), Some(original));
    assert_eq!(
        store
            .decoded()
            .get(signature, "dlmm".to_owned())
            .await
            .unwrap(),
        Some(replacement),
    );
}
