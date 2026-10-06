//! The tracked wallets, each with its listing cursor and how much of it is listed.
//!
//! Adding a wallet creates its cursor in the same transaction, so a tracked wallet always has
//! one. This module stores and lists wallets; what to do with them is the engine's job.

use std::collections::BTreeMap;

use binsight_solana::Address;
use jiff::Timestamp;
use rusqlite::{Row, params};

use super::cursor::{WalletCursor, cursor_from_row, cursor_to_sql};
use crate::database::Database;
use crate::database::codec::{
    parse_from_sql, timestamp_from_sql, timestamp_to_sql, unsigned_from_sql,
};
use crate::error::StoreError;
use crate::store::Store;

const INSERT_WALLET: &str = "
    INSERT INTO wallet (address, added_at) VALUES (?1, ?2) ON CONFLICT (address) DO NOTHING";
const INSERT_CURSOR: &str = "
    INSERT INTO wallet_cursor (wallet, top_signature, top_slot, history_before, history_state)
    VALUES (?1, ?2, ?3, ?4, ?5)";
const SELECT_ALL: &str = "
    SELECT w.address, w.added_at, c.top_signature, c.top_slot, c.history_before, c.history_state
    FROM wallet w JOIN wallet_cursor c ON c.wallet = w.address
    ORDER BY w.added_at, w.address";

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

/// A tracked wallet and how far its signatures are listed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TrackedWallet {
    /// The wallet's address.
    pub address: Address,
    /// When it was added.
    pub added_at: Timestamp,
    /// How far its signatures are listed.
    pub cursor: WalletCursor,
}

/// Reads and writes the tracked wallets. Get one with [`Store::wallets`].
#[derive(Debug, Clone)]
pub struct WalletsRepo {
    database: Database,
}

impl Store {
    /// The tracked wallets.
    pub fn wallets(&self) -> WalletsRepo {
        WalletsRepo {
            database: self.database().clone(),
        }
    }
}

impl WalletsRepo {
    /// Starts tracking `address`, with nothing listed yet. Returns whether it was added (`false`
    /// if it was already tracked).
    ///
    /// # Errors
    ///
    /// Returns an error if the database cannot be written; nothing is added then.
    pub async fn add(&self, address: Address, added_at: Timestamp) -> Result<bool, StoreError> {
        self.database
            .write(move |connection| {
                let transaction = connection.transaction()?;
                let address = address.to_string();
                let added = transaction
                    .execute(INSERT_WALLET, params![address, timestamp_to_sql(added_at)])?;
                if added == 1 {
                    let (top_signature, top_slot, before, state) =
                        cursor_to_sql(&WalletCursor::NotStarted)?;
                    transaction.execute(
                        INSERT_CURSOR,
                        params![address, top_signature, top_slot, before, state],
                    )?;
                }
                transaction.commit()?;
                Ok(added == 1)
            })
            .await
    }

    /// Every tracked wallet, the oldest first.
    ///
    /// # Errors
    ///
    /// Returns an error if the database cannot be read or holds an invalid row.
    pub async fn list(&self) -> Result<Vec<TrackedWallet>, StoreError> {
        self.database
            .read(|connection| {
                let mut query = connection.prepare(SELECT_ALL)?;
                let rows = query.query_map([], |row| Ok(wallet_from_row(row)))?;
                rows.map(|row| row?).collect()
            })
            .await
    }
}

impl WalletsRepo {
    /// How much of each tracked wallet's history is listed; read from counters, whatever the
    /// size of the histories.
    ///
    /// # Errors
    ///
    /// Returns an error if the database cannot be read or holds an invalid row.
    pub async fn listings(&self) -> Result<BTreeMap<Address, WalletListing>, StoreError> {
        self.database
            .read(|connection| {
                let mut query = connection.prepare(SELECT_LISTINGS)?;
                let mut rows = query.query([])?;
                let mut listings = BTreeMap::new();
                while let Some(row) = rows.next()? {
                    let wallet = parse_from_sql(&row.get::<_, String>(0)?, "wallet address")?;
                    let newest: Option<i64> = row.get(2)?;
                    let listing = WalletListing {
                        listed: unsigned_from_sql(row.get(1)?, "listed count")?,
                        newest_block_time: newest.map(timestamp_from_sql).transpose()?,
                    };
                    listings.insert(wallet, listing);
                }
                Ok(listings)
            })
            .await
    }
}

fn wallet_from_row(row: &Row<'_>) -> Result<TrackedWallet, StoreError> {
    Ok(TrackedWallet {
        address: parse_from_sql(&row.get::<_, String>(0)?, "wallet address")?,
        added_at: timestamp_from_sql(row.get(1)?)?,
        cursor: cursor_from_row(row, 2)?,
    })
}

#[cfg(test)]
mod tests {
    use binsight_solana::Signature;

    use super::*;
    use crate::database::test_database::{assert_queries_prepare, migrated_store};
    use crate::ingestion::ListedTop;

    #[tokio::test]
    async fn prepares_every_query_against_the_schema() {
        assert_queries_prepare(&[INSERT_WALLET, INSERT_CURSOR, SELECT_ALL, SELECT_LISTINGS]).await;
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

        let listing = store.wallets().listings().await.unwrap()[&WALLET];

        assert_eq!(listing.listed, 4);
        assert_eq!(
            listing.listed,
            store.fetch_queue().counts(WALLET).await.unwrap().listed
        );
        assert_eq!(listing.newest_block_time, Some(listed_at()));
    }

    #[tokio::test]
    async fn tracks_a_new_wallet_with_nothing_listed_and_only_once() {
        let (_folder, store) = migrated_store().await;
        let address = Address::from_bytes([1; 32]);
        let added_at = Timestamp::from_second(1_790_000_000).unwrap();

        assert!(store.wallets().add(address, added_at).await.unwrap());
        assert!(!store.wallets().add(address, added_at).await.unwrap());

        assert_eq!(
            store.wallets().list().await.unwrap(),
            vec![TrackedWallet {
                address,
                added_at,
                cursor: WalletCursor::NotStarted
            }]
        );
    }

    #[tokio::test]
    async fn refuses_a_cursor_listing_a_history_without_a_page_to_continue_from() {
        let (_folder, store) = migrated_store().await;
        store
            .wallets()
            .add(Address::from_bytes([1; 32]), Timestamp::UNIX_EPOCH)
            .await
            .unwrap();
        let top = ListedTop {
            signature: Signature::from_bytes([2; 64]),
            slot: 5,
        };
        let (signature, slot, _, _) =
            cursor_to_sql(&WalletCursor::HistoryComplete { top: Some(top) }).unwrap();

        let attempt = store
            .database()
            .write(move |connection| {
                Ok(connection.execute(
                    "UPDATE wallet_cursor SET top_signature = ?1, top_slot = ?2,
                     history_state = 'listing'",
                    params![signature, slot],
                )?)
            })
            .await;

        assert!(matches!(attempt, Err(StoreError::Sqlite(_))));
    }
}
