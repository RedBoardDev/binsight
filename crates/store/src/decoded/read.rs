//! Reading one decoding result back, for tests: production code only writes results.

use binsight_solana::Signature;
use binsight_solana::transaction::TxOutcome;
use rusqlite::{Connection, OptionalExtension, params};

use super::{DecodeOutcome, DecodeRecord, DecodedEvent, DecodedRepo};
use crate::database::codec::{timestamp_from_sql, version_from_sql};
use crate::error::StoreError;

pub(super) const SELECT_DECODE: &str = "
    SELECT decoder_version, outcome, error, decoded_at, execution_outcome, execution_error
    FROM tx_decode WHERE signature = ?1 AND decoder = ?2";
pub(super) const SELECT_EVENTS: &str = "
    SELECT kind, payload FROM decoded_event
    WHERE signature = ?1 AND decoder = ?2 ORDER BY event_index";

impl DecodedRepo {
    /// The latest result of `decoder` on `signature`, if it ran.
    ///
    /// # Errors
    ///
    /// Returns an error if the database cannot be read or holds an invalid row.
    pub async fn get(
        &self,
        signature: Signature,
        decoder: String,
    ) -> Result<Option<DecodeRecord>, StoreError> {
        self.database
            .read(move |connection| {
                read_snapshot(connection, |snapshot| {
                    read_record(snapshot, signature, decoder)
                })
            })
            .await
    }
}

/// Reads metadata and events under a single SQLite snapshot, even during a concurrent write.
pub(super) fn read_snapshot(
    connection: &Connection,
    read: impl FnOnce(&Connection) -> Result<Option<DecodeRecord>, StoreError>,
) -> Result<Option<DecodeRecord>, StoreError> {
    let transaction = connection.unchecked_transaction()?;
    let record = read(&transaction)?;
    transaction.commit()?;
    Ok(record)
}

/// Reads one result and, if it decoded anything, its events in order.
pub(super) fn read_record(
    connection: &Connection,
    signature: Signature,
    decoder: String,
) -> Result<Option<DecodeRecord>, StoreError> {
    let key = params![signature.to_string(), decoder];
    let Some((version, outcome, error, decoded_at, execution_outcome, execution_error)) =
        connection
            .query_row(SELECT_DECODE, key, |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, Option<String>>(4)?,
                    row.get::<_, Option<String>>(5)?,
                ))
            })
            .optional()?
    else {
        return Ok(None);
    };
    let outcome = match (outcome.as_str(), error) {
        ("decoded", None) => DecodeOutcome::Decoded(read_events(connection, key)?),
        ("not_applicable", None) => DecodeOutcome::NotApplicable,
        ("failed", Some(error)) => DecodeOutcome::Failed { error },
        _ => {
            return Err(StoreError::InvalidStoredValue {
                what: "decode outcome",
                value: outcome,
            });
        }
    };
    Ok(Some(DecodeRecord {
        signature,
        decoder,
        decoder_version: version_from_sql(version)?,
        execution_outcome: read_execution(execution_outcome, execution_error)?,
        outcome,
        decoded_at: timestamp_from_sql(decoded_at)?,
    }))
}

fn read_events(
    connection: &Connection,
    key: &[&dyn rusqlite::ToSql],
) -> Result<Vec<DecodedEvent>, StoreError> {
    let mut statement = connection.prepare(SELECT_EVENTS)?;
    let rows = statement.query_map(key, |row| {
        Ok(DecodedEvent {
            kind: row.get(0)?,
            payload_json: row.get(1)?,
        })
    })?;
    Ok(rows.collect::<Result<_, _>>()?)
}

/// Unknown legacy execution facts stay unknown instead of being turned into success.
fn read_execution(
    outcome: Option<String>,
    error: Option<String>,
) -> Result<Option<TxOutcome>, StoreError> {
    match (outcome.as_deref(), error) {
        (None, None) => Ok(None),
        (Some("succeeded"), None) => Ok(Some(TxOutcome::Succeeded)),
        (Some("failed"), Some(error)) => Ok(Some(TxOutcome::Failed { error })),
        _ => Err(StoreError::InvalidStoredValue {
            what: "transaction execution outcome",
            value: outcome.unwrap_or_else(|| "null".to_owned()),
        }),
    }
}
