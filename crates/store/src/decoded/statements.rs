//! The SQL that writes one decoding result (`tx_decode` and its `decoded_event` rows).
//!
//! These functions run on a connection the caller provides; replacing a result must happen inside
//! the caller's transaction so it is all-or-nothing.

use binsight_solana::transaction::TxOutcome;
use rusqlite::{Connection, params};

use super::{DecodeOutcome, DecodeRecord};
use crate::database::codec::{timestamp_to_sql, version_to_sql};
use crate::error::StoreError;

pub(super) const DELETE_DECODE: &str =
    "DELETE FROM tx_decode WHERE signature = ?1 AND decoder = ?2";
pub(super) const INSERT_DECODE: &str = "
    INSERT INTO tx_decode (signature, decoder, decoder_version, outcome, error, decoded_at,
                           execution_outcome, execution_error)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)";
pub(super) const INSERT_EVENT: &str = "
    INSERT INTO decoded_event (signature, decoder, event_index, decoder_version, kind, payload)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6)";
/// Deletes the previous result (its events go with it) and inserts the new one.
pub(super) fn replace_record(
    connection: &Connection,
    record: &DecodeRecord,
) -> Result<(), StoreError> {
    let signature = record.signature.to_string();
    let version = version_to_sql(record.decoder_version);
    let (outcome, error) = match &record.outcome {
        DecodeOutcome::Decoded(_) => ("decoded", None),
        DecodeOutcome::NotApplicable => ("not_applicable", None),
        DecodeOutcome::Failed { error } => ("failed", Some(error.as_str())),
    };
    let (execution_outcome, execution_error) = match &record.execution_outcome {
        None => (None, None),
        Some(TxOutcome::Succeeded) => (Some("succeeded"), None),
        Some(TxOutcome::Failed { error }) => (Some("failed"), Some(error.as_str())),
    };
    connection.execute(DELETE_DECODE, params![signature, record.decoder])?;
    connection.execute(
        INSERT_DECODE,
        params![
            signature,
            record.decoder,
            version,
            outcome,
            error,
            timestamp_to_sql(record.decoded_at),
            execution_outcome,
            execution_error
        ],
    )?;
    let DecodeOutcome::Decoded(events) = &record.outcome else {
        return Ok(());
    };
    for (index, event) in events.iter().enumerate() {
        let index = i64::try_from(index).map_err(|_| StoreError::ValueTooLarge {
            what: "event index",
            value: index.to_string(),
        })?;
        connection.execute(
            INSERT_EVENT,
            params![
                signature,
                record.decoder,
                index,
                version,
                event.kind,
                event.payload_json
            ],
        )?;
    }
    Ok(())
}
