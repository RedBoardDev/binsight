//! Bounded traversal of a wallet's listed metadata, including transactions not yet fetched.
//!
//! Signature text order is a storage traversal order, never proof of financial chronology.

use binsight_solana::{Address, Signature};
use rusqlite::params;

use super::{ListedSignature, SignaturesRepo, listed_from_row};
use crate::error::StoreError;

/// One bounded page of the signatures listed for a wallet.
#[derive(Debug, Clone, Copy)]
pub struct WalletSignatureScan {
    /// The wallet whose listed metadata is read.
    pub wallet: Address,
    /// The previous page's last signature, in SQL text order.
    pub after: Option<Signature>,
    /// The maximum number of records returned; zero returns an empty page.
    pub limit: u16,
}

const SELECT_LISTED: &str = "
    SELECT slot, slot_order, block_time, is_failed, signature FROM wallet_signature
    WHERE wallet = ?1 AND signature > ?2
    ORDER BY signature LIMIT ?3";

impl SignaturesRepo {
    /// Reads listed metadata without hiding missing raw transactions or unknown ordinals.
    ///
    /// The cursor resumes in signature text order, not chain order. Each page is a single
    /// read, but pages do not share a snapshot: ingestion can add signatures or shift
    /// wallet-local ordinals between calls. An ordered replay must establish a consistent
    /// metadata snapshot separately; this scan cannot prove complete history or exact order.
    /// Restarting with `after: None` discovers additions before an earlier cursor.
    ///
    /// # Errors
    /// Returns an error if the database cannot be read or holds invalid listed metadata.
    pub async fn scan(
        &self,
        scan: WalletSignatureScan,
    ) -> Result<Vec<ListedSignature>, StoreError> {
        self.database
            .read(move |connection| {
                let mut statement = connection.prepare(SELECT_LISTED)?;
                let rows = statement.query_map(
                    params![
                        scan.wallet.to_string(),
                        scan.after
                            .map_or_else(String::new, |signature| signature.to_string()),
                        i64::from(scan.limit),
                    ],
                    |row| Ok(listed_from_row(row)),
                )?;
                rows.map(|row| row?).collect()
            })
            .await
    }
}

#[cfg(test)]
mod tests;
