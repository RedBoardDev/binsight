//! Execution outcome survives decoder failure and replacement.

use binsight_solana::transaction::TxOutcome;

use super::{DecodeOutcome, DecodeRecord};
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

#[tokio::test]
async fn distinguishes_failed_execution_from_failed_decoding() {
    let (_folder, store) = migrated_store().await;
    store
        .raw_tx()
        .insert_if_absent(sample_record(31))
        .await
        .unwrap();
    let executed_failure = record(
        DecodeOutcome::Decoded,
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
