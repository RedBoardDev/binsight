//! Freeze one wallet's listed metadata before adapters resolve its transaction replay order.
//!
//! Raw payloads are not loaded here. Missing rows, ranks and dates remain visible; neither
//! complete history nor canonical transaction indices follow from this storage snapshot.

use binsight_solana::Address;
use rusqlite::{Connection, params};

use super::{ListedSignature, SignaturesRepo, listed_from_row};
use crate::error::StoreError;

const SELECT_SNAPSHOT: &str = "
    SELECT slot, slot_order, block_time, is_failed, signature FROM wallet_signature
    WHERE wallet = ?1 ORDER BY signature";

impl SignaturesRepo {
    /// Captures all listed metadata for `wallet` in one read-only SQLite transaction.
    ///
    /// Unlike successive [`Self::scan`] pages, these owned rows retain mutually consistent
    /// wallet-local ranks when concurrent ingestion inserts a same-slot prefix. Signature
    /// text order is only storage traversal order; the adapter chooses a uniform replay
    /// order and checks the raw payloads separately. Later changes require another capture.
    ///
    /// Memory grows with this wallet's listed metadata, without loading its raw payloads.
    /// Missing raw transactions are not filtered out and this is not a history-coverage proof.
    ///
    /// # Errors
    /// Returns an error if the database cannot be read or any listed metadata is invalid.
    pub async fn metadata_snapshot(
        &self,
        wallet: Address,
    ) -> Result<Vec<ListedSignature>, StoreError> {
        self.database
            .read(move |connection| {
                read_snapshot(connection, |snapshot| read_listed(snapshot, wallet))
            })
            .await
    }
}

fn read_snapshot(
    connection: &Connection,
    read: impl FnOnce(&Connection) -> Result<Vec<ListedSignature>, StoreError>,
) -> Result<Vec<ListedSignature>, StoreError> {
    let transaction = connection.unchecked_transaction()?;
    let listed = read(&transaction)?;
    transaction.commit()?;
    Ok(listed)
}

fn read_listed(
    connection: &Connection,
    wallet: Address,
) -> Result<Vec<ListedSignature>, StoreError> {
    let mut statement = connection.prepare(SELECT_SNAPSHOT)?;
    let rows = statement.query_map(params![wallet.to_string()], |row| Ok(listed_from_row(row)))?;
    rows.map(|row| row?).collect()
}

#[cfg(test)]
mod tests;
