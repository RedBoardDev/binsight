//! The SQL that writes one decoding result (`tx_decode`).
//!
//! These functions run on a connection the caller provides. A result replaces the previous one
//! of the same decoder in a single statement, so it is all-or-nothing.

use binsight_solana::transaction::TxOutcome;
use rusqlite::{Connection, params};

use super::{DecodeOutcome, DecodeRecord};
use crate::database::codec::{timestamp_to_sql, version_to_sql};
use crate::error::StoreError;

pub(super) const UPSERT_DECODE: &str = "
    INSERT INTO tx_decode (signature, decoder, decoder_version, outcome, error, decoded_at,
                           execution_outcome, execution_error)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
    ON CONFLICT (signature, decoder) DO UPDATE
    SET decoder_version = excluded.decoder_version, outcome = excluded.outcome,
        error = excluded.error, decoded_at = excluded.decoded_at,
        execution_outcome = excluded.execution_outcome,
        execution_error = excluded.execution_error";

/// Writes `record` in place of the previous result of its decoder on its transaction.
pub(super) fn replace_record(
    connection: &Connection,
    record: &DecodeRecord,
) -> Result<(), StoreError> {
    let (outcome, error) = match &record.outcome {
        DecodeOutcome::Decoded => ("decoded", None),
        DecodeOutcome::NotApplicable => ("not_applicable", None),
        DecodeOutcome::Failed { error } => ("failed", Some(error.as_str())),
    };
    let (execution_outcome, execution_error) = match &record.execution_outcome {
        None => (None, None),
        Some(TxOutcome::Succeeded) => (Some("succeeded"), None),
        Some(TxOutcome::Failed { error }) => (Some("failed"), Some(error.as_str())),
    };
    connection.execute(
        UPSERT_DECODE,
        params![
            record.signature.to_string(),
            record.decoder,
            version_to_sql(record.decoder_version),
            outcome,
            error,
            timestamp_to_sql(record.decoded_at),
            execution_outcome,
            execution_error
        ],
    )?;
    Ok(())
}
