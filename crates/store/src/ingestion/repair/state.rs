//! Where each wallet's repair stands: the point down to which a repair verified its listing,
//! and when the last repair ended.
//!
//! A repair lists a wallet's signatures again from the newest down to that point and refills
//! what the registry lacks (`page`). A wallet never repaired, or whose repair was asked in
//! full, has no point: the engine then repairs its whole history. This module stores the points;
//! when to repair and how far are the engine's decisions.

use binsight_solana::Address;
use jiff::Timestamp;
use rusqlite::{OptionalExtension, Row, params};

use crate::database::Database;
use crate::database::codec::{
    parse_from_sql, timestamp_from_sql, timestamp_to_sql, unsigned_from_sql, unsigned_to_sql,
};
use crate::error::StoreError;
use crate::ingestion::ListedTop;
use crate::store::Store;

const SELECT_ALL: &str = "
    SELECT wallet, verified_signature, verified_slot, repaired_at FROM wallet_repair
    ORDER BY wallet";
const UPSERT: &str = "
    INSERT INTO wallet_repair (wallet, verified_signature, verified_slot, repaired_at)
    VALUES (?1, ?2, ?3, ?4)
    ON CONFLICT (wallet) DO UPDATE
    SET verified_signature = excluded.verified_signature, verified_slot = excluded.verified_slot,
        repaired_at = excluded.repaired_at";
const ASK_FULL: &str = "
    INSERT INTO wallet_repair (wallet, verified_signature, verified_slot, repaired_at)
    VALUES (?1, NULL, NULL, NULL)
    ON CONFLICT (wallet) DO UPDATE
    SET verified_signature = NULL, verified_slot = NULL, repaired_at = NULL";
const SELECT_OLDEST_SLOT: &str = "SELECT min(slot) FROM wallet_signature WHERE wallet = ?1";

/// Where one wallet's repair stands.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WalletRepair {
    /// The wallet.
    pub wallet: Address,
    /// The point down to which a repair verified its listing: every signature older than it was
    /// compared with a listing; `None` when no repair verified anything yet.
    pub verified: Option<ListedTop>,
    /// When its last repair ended; `None` while a full repair is asked.
    pub repaired_at: Option<Timestamp>,
}

/// Reads and writes where the repairs stand. Get one with [`Store::repairs`].
#[derive(Debug, Clone)]
pub struct RepairsRepo {
    pub(super) database: Database,
}

impl Store {
    /// Where each wallet's repair stands.
    pub fn repairs(&self) -> RepairsRepo {
        RepairsRepo {
            database: self.database().clone(),
        }
    }
}

impl RepairsRepo {
    /// Every wallet repaired at least once, or asked a full repair, by address; a wallet left
    /// out was never repaired.
    ///
    /// # Errors
    ///
    /// Returns an error if the database cannot be read or holds an invalid row.
    pub async fn list(&self) -> Result<Vec<WalletRepair>, StoreError> {
        self.database
            .read(|connection| {
                let mut query = connection.prepare(SELECT_ALL)?;
                let rows = query.query_map([], |row| Ok(repair_from_row(row)))?;
                rows.map(|row| row?).collect()
            })
            .await
    }

    /// Records that a repair of `repair.wallet` ended, with the point it verified.
    ///
    /// # Errors
    ///
    /// Returns an error if the wallet is not tracked or the database cannot be written.
    pub async fn record(&self, repair: WalletRepair) -> Result<(), StoreError> {
        self.database
            .write(move |connection| {
                let (signature, slot) = match repair.verified {
                    Some(top) => (
                        Some(top.signature.to_string()),
                        Some(unsigned_to_sql(top.slot, "slot")?),
                    ),
                    None => (None, None),
                };
                connection.execute(
                    UPSERT,
                    params![
                        repair.wallet.to_string(),
                        signature,
                        slot,
                        repair.repaired_at.map(timestamp_to_sql)
                    ],
                )?;
                Ok(())
            })
            .await
    }

    /// Asks a full repair of `wallet`: its verified point is forgotten, so its next repair
    /// lists its whole history, at once.
    ///
    /// # Errors
    ///
    /// Returns an error if the wallet is not tracked or the database cannot be written.
    pub async fn ask_full(&self, wallet: Address) -> Result<(), StoreError> {
        self.database
            .write(move |connection| {
                connection.execute(ASK_FULL, [wallet.to_string()])?;
                Ok(())
            })
            .await
    }

    /// The slot of the oldest signature listed for `wallet`, if it lists any: a repair of the
    /// whole history that stops above it did not reach the wallet's first transaction.
    ///
    /// # Errors
    ///
    /// Returns an error if the database cannot be read.
    pub async fn oldest_listed_slot(&self, wallet: Address) -> Result<Option<u64>, StoreError> {
        self.database
            .read(move |connection| {
                let slot: Option<i64> = connection
                    .query_row(SELECT_OLDEST_SLOT, [wallet.to_string()], |row| row.get(0))
                    .optional()?
                    .flatten();
                slot.map(|slot| unsigned_from_sql(slot, "slot")).transpose()
            })
            .await
    }
}

fn repair_from_row(row: &Row<'_>) -> Result<WalletRepair, StoreError> {
    let signature: Option<String> = row.get(1)?;
    let slot: Option<i64> = row.get(2)?;
    let verified = match (signature, slot) {
        (Some(signature), Some(slot)) => Some(ListedTop {
            signature: parse_from_sql(&signature, "signature")?,
            slot: unsigned_from_sql(slot, "slot")?,
        }),
        _ => None,
    };
    Ok(WalletRepair {
        wallet: parse_from_sql(&row.get::<_, String>(0)?, "wallet address")?,
        verified,
        repaired_at: row
            .get::<_, Option<i64>>(3)?
            .map(timestamp_from_sql)
            .transpose()?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::database::test_database::assert_queries_prepare;
    use crate::ingestion::test_pages::{
        WALLET, history_page, later, listed, listed_at, store_with_wallet,
    };

    #[tokio::test]
    async fn prepares_every_query_against_the_schema() {
        assert_queries_prepare(&[SELECT_ALL, UPSERT, ASK_FULL, SELECT_OLDEST_SLOT]).await;
    }

    #[tokio::test]
    async fn keeps_the_last_verified_point_until_a_full_repair_is_asked() {
        let (_folder, store) = store_with_wallet().await;
        let repairs = store.repairs();
        assert_eq!(repairs.list().await.unwrap(), Vec::new());
        let verified = ListedTop {
            signature: listed(4, 40).signature,
            slot: 40,
        };
        let first = WalletRepair {
            wallet: WALLET,
            verified: None,
            repaired_at: Some(listed_at()),
        };
        let second = WalletRepair {
            verified: Some(verified),
            repaired_at: Some(later(60)),
            ..first
        };

        repairs.record(first).await.unwrap();
        repairs.record(second).await.unwrap();

        assert_eq!(repairs.list().await.unwrap(), vec![second]);
        repairs.ask_full(WALLET).await.unwrap();
        let asked = WalletRepair {
            wallet: WALLET,
            verified: None,
            repaired_at: None,
        };
        assert_eq!(repairs.list().await.unwrap(), vec![asked]);
    }

    #[tokio::test]
    async fn refuses_to_ask_a_full_repair_of_a_wallet_that_is_not_tracked() {
        let (_folder, store) = crate::database::test_database::migrated_store().await;

        let attempt = store.repairs().ask_full(WALLET).await;

        assert!(matches!(attempt, Err(StoreError::Sqlite(_))));
    }

    #[tokio::test]
    async fn finds_the_slot_of_the_oldest_listed_signature() {
        let (_folder, store) = store_with_wallet().await;
        assert_eq!(
            store.repairs().oldest_listed_slot(WALLET).await.unwrap(),
            None
        );
        let page = history_page(WALLET, vec![listed(2, 20), listed(3, 10)]);
        store.signatures().record_listing(page).await.unwrap();

        assert_eq!(
            store.repairs().oldest_listed_slot(WALLET).await.unwrap(),
            Some(10)
        );
    }
}
