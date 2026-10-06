//! Finding the transactions a decoder has not read at its current version, without walking the
//! whole registry each time.
//!
//! The registry is read in the order its rows were inserted (SQLite's `rowid`; rows are never
//! deleted, so a new row always comes after every older one). A scan starts after a
//! [`RegistryPosition`] and reports how far it looked, so the next scan only reads the rows
//! inserted since. The first scan of a process starts from the beginning, which is how a decoder
//! version bump finds every result to redo. The position is only kept in memory: a `VACUUM` may
//! renumber the rows, and the next start scans everything again anyway. This order is never the
//! chronological order of transactions.

use binsight_solana::Signature;
use rusqlite::params;

use super::DecodedRepo;
use crate::database::codec::parse_from_sql;
use crate::error::StoreError;

/// A place in the registry's insertion order: everything up to it was looked at.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, PartialOrd, Ord)]
pub struct RegistryPosition(i64);

impl RegistryPosition {
    /// Before the first transaction of the registry.
    pub const START: Self = Self(0);
}

/// One bounded scan of the registry for a decoder version.
#[derive(Debug, Clone)]
pub struct DecodeScan {
    /// The decoder whose results are inspected.
    pub decoder: String,
    /// The minimum version a result must have to be skipped.
    pub decoder_version: u32,
    /// Where the previous scan stopped.
    pub after: RegistryPosition,
    /// The maximum number of signatures returned.
    pub limit: u16,
}

/// What one scan found.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DecodeBacklog {
    /// The transactions to decode, in insertion order.
    pub signatures: Vec<Signature>,
    /// How far the scan looked: the next scan starts after it.
    pub scanned_to: RegistryPosition,
    /// Whether the scan stopped at its limit, so more may wait right after `scanned_to`.
    pub is_truncated: bool,
}

const SELECT_LAST_POSITION: &str = "SELECT coalesce(max(rowid), 0) FROM raw_tx";
const SELECT_PENDING: &str = "
    SELECT raw.rowid, raw.signature FROM raw_tx AS raw
    LEFT JOIN tx_decode AS decoded
      ON decoded.signature = raw.signature AND decoded.decoder = ?1
    WHERE raw.rowid > ?3 AND raw.rowid <= ?4
      AND (decoded.decoder_version IS NULL OR decoded.decoder_version < ?2)
    ORDER BY raw.rowid LIMIT ?5";

impl DecodedRepo {
    /// Finds, after `scan.after`, the transactions without a result at `scan.decoder_version` or
    /// a newer version. Failed and not-applicable results at the current version are skipped
    /// too: decoding is a pure function of the immutable payload, so they would fail again.
    ///
    /// # Errors
    ///
    /// Returns an error if the database cannot be read or holds a malformed signature.
    pub async fn pending(&self, scan: DecodeScan) -> Result<DecodeBacklog, StoreError> {
        self.database
            .read(move |connection| {
                let last: i64 = connection.query_row(SELECT_LAST_POSITION, [], |row| row.get(0))?;
                let mut statement = connection.prepare(SELECT_PENDING)?;
                let rows = statement.query_map(
                    params![
                        scan.decoder,
                        i64::from(scan.decoder_version),
                        scan.after.0,
                        last,
                        i64::from(scan.limit),
                    ],
                    |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)),
                )?;
                let mut signatures = Vec::new();
                let mut reached = None;
                for row in rows {
                    let (position, signature) = row?;
                    signatures.push(parse_from_sql(&signature, "pending decode signature")?);
                    reached = Some(position);
                }
                let is_truncated = signatures.len() >= usize::from(scan.limit);
                let scanned_to = match (is_truncated, reached) {
                    (true, Some(position)) => position,
                    (true, None) => scan.after.0,
                    (false, _) => last.max(scan.after.0),
                };
                Ok(DecodeBacklog {
                    signatures,
                    scanned_to: RegistryPosition(scanned_to),
                    is_truncated,
                })
            })
            .await
    }
}

#[cfg(test)]
mod tests;
