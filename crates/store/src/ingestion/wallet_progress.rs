//! How far each tracked wallet's ingestion is: its cursor, how much is listed and what is not
//! fetched yet, read in one snapshot so the three agree.
//!
//! Everything here comes from counters and from the fetch tasks not done yet, never from a
//! wallet's whole history, so the read costs the work left, not the size of the histories.

use binsight_solana::Address;
use jiff::Timestamp;
use rusqlite::Connection;

use super::fetch_counts::{WalletBacklog, read_backlogs};
use super::wallets::{TrackedWallet, WalletsRepo, list_wallets};
use crate::database::codec::{parse_from_sql, timestamp_from_sql, unsigned_from_sql};
use crate::error::StoreError;

// The newest listed signature is the cursor's top: one lookup per wallet, whatever its history.
const SELECT_LISTINGS: &str = "
    SELECT c.wallet, c.listed_count, s.block_time
    FROM wallet_cursor AS c
    LEFT JOIN wallet_signature AS s ON s.wallet = c.wallet AND s.signature = c.top_signature";

/// How much of a wallet's history is listed.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct WalletListing {
    /// How many signatures are listed for it.
    pub listed: u64,
    /// When the block of its newest listed signature was produced, if known.
    pub newest_block_time: Option<Timestamp>,
}

/// One tracked wallet and how far its ingestion is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WalletProgress {
    /// The wallet and its cursor.
    pub wallet: TrackedWallet,
    /// What keeps its registry behind.
    pub backlog: WalletBacklog,
    /// How much of its history is listed.
    pub listing: WalletListing,
}

impl WalletsRepo {
    /// Every tracked wallet, the oldest first, with how far its ingestion is, all read in one
    /// snapshot.
    ///
    /// # Errors
    ///
    /// Returns an error if the database cannot be read or holds an invalid row.
    pub async fn progress(&self) -> Result<Vec<WalletProgress>, StoreError> {
        self.database
            .read(|connection| {
                let snapshot = connection.unchecked_transaction()?;
                let wallets = list_wallets(&snapshot)?;
                let backlogs = read_backlogs(&snapshot)?;
                let listings = read_listings(&snapshot)?;
                snapshot.commit()?;
                Ok(wallets
                    .into_iter()
                    .map(|wallet| WalletProgress {
                        backlog: backlogs.get(&wallet.address).copied().unwrap_or_default(),
                        listing: listings
                            .iter()
                            .find(|(address, _)| *address == wallet.address)
                            .map(|(_, listing)| *listing)
                            .unwrap_or_default(),
                        wallet,
                    })
                    .collect())
            })
            .await
    }
}

/// Every wallet's listing, from its cursor.
fn read_listings(connection: &Connection) -> Result<Vec<(Address, WalletListing)>, StoreError> {
    let mut query = connection.prepare(SELECT_LISTINGS)?;
    let mut rows = query.query([])?;
    let mut listings = Vec::new();
    while let Some(row) = rows.next()? {
        let wallet = parse_from_sql(&row.get::<_, String>(0)?, "wallet address")?;
        let newest: Option<i64> = row.get(2)?;
        let listing = WalletListing {
            listed: unsigned_from_sql(row.get(1)?, "listed count")?,
            newest_block_time: newest.map(timestamp_from_sql).transpose()?,
        };
        listings.push((wallet, listing));
    }
    Ok(listings)
}

#[cfg(test)]
mod tests {
    use binsight_solana::Signature;

    use super::*;
    use crate::database::test_database::{assert_queries_prepare, migrated_store};

    #[tokio::test]
    async fn prepares_every_query_against_the_schema() {
        assert_queries_prepare(&[SELECT_LISTINGS]).await;
    }

    #[tokio::test]
    async fn counts_each_signature_listed_or_streamed_once() {
        use crate::ingestion::test_pages::{WALLET, history_page, listed, listed_at, page_after};

        let (_folder, store) = migrated_store().await;
        store.wallets().add(WALLET, listed_at()).await.unwrap();
        let first = history_page(WALLET, vec![listed(2, 30), listed(3, 20)]);
        let overlapping = page_after(&first, vec![listed(3, 20), listed(4, 10)]);
        store.signatures().record_listing(first).await.unwrap();
        store
            .signatures()
            .record_listing(overlapping)
            .await
            .unwrap();
        for _seen_twice in 0..2 {
            store
                .signatures()
                .record_detected(crate::DetectedSignature {
                    wallet: WALLET,
                    signature: Signature::from_bytes([9; 64]),
                    slot: 40,
                    is_failed: false,
                    detected_at: listed_at(),
                    fetch_at: listed_at(),
                })
                .await
                .unwrap();
        }

        let progress = store.wallets().progress().await.unwrap();

        let listing = progress[0].listing;
        assert_eq!(listing.listed, 4);
        assert_eq!(
            listing.listed,
            store.fetch_queue().counts(WALLET).await.unwrap().listed
        );
        assert_eq!(listing.newest_block_time, Some(listed_at()));
        assert_eq!(progress[0].backlog.unfetched, 4);
    }
}
