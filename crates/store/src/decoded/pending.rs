//! Bounded registry traversal finds transactions a decoder has not read at its current version.
//!
//! The signature cursor is a storage scan order, never the chronological order of transactions.

use binsight_solana::Signature;
use rusqlite::params;

use super::DecodedRepo;
use crate::database::codec::parse_from_sql;
use crate::error::StoreError;

/// One bounded traversal of the immutable registry for a decoder version.
#[derive(Debug, Clone)]
pub struct DecodeScan {
    /// The decoder whose results are inspected.
    pub decoder: String,
    /// The minimum version a result must have to be skipped.
    pub decoder_version: u32,
    /// The last signature of the previous batch, in SQL text order.
    pub after: Option<Signature>,
    /// The maximum number of signatures returned.
    pub limit: u16,
}

const SELECT_PENDING: &str = "
    SELECT raw.signature FROM raw_tx AS raw
    LEFT JOIN tx_decode AS decoded
      ON decoded.signature = raw.signature AND decoded.decoder = ?1
    WHERE raw.signature > ?3
      AND (decoded.decoder_version IS NULL OR decoded.decoder_version < ?2)
    ORDER BY raw.signature LIMIT ?4";

impl DecodedRepo {
    /// Finds a batch without a result at `scan.decoder_version` or a newer version.
    ///
    /// Failed and not-applicable results at the current version are also skipped. Restarting
    /// with `after: None` discovers new registry entries on either side of the previous cursor.
    ///
    /// # Errors
    ///
    /// Returns an error if the database cannot be read or holds a malformed signature.
    pub async fn pending(&self, scan: DecodeScan) -> Result<Vec<Signature>, StoreError> {
        self.database
            .read(move |connection| {
                let mut statement = connection.prepare(SELECT_PENDING)?;
                let rows = statement.query_map(
                    params![
                        scan.decoder,
                        i64::from(scan.decoder_version),
                        scan.after
                            .map_or_else(String::new, |signature| signature.to_string()),
                        i64::from(scan.limit),
                    ],
                    |row| row.get::<_, String>(0),
                )?;
                rows.map(|row| parse_from_sql(&row?, "pending decode signature"))
                    .collect()
            })
            .await
    }
}

#[cfg(test)]
mod tests;
