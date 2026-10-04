//! The signatures listed for each wallet, and reading one back.
//!
//! A signature is written with its listed page (`listing_page`), in one transaction with its fetch
//! task and the cursor move. This module names a listed signature and reads one; which page to
//! list and where the cursor goes are the engine's decisions.

use binsight_solana::{Address, Signature};
use jiff::Timestamp;
use rusqlite::{OptionalExtension, Row, params};

use crate::database::Database;
use crate::database::codec::{flag_from_sql, timestamp_from_sql, u32_from_sql, unsigned_from_sql};
use crate::error::StoreError;
use crate::store::Store;

const SELECT_SIGNATURE: &str = "
    SELECT slot, slot_order, block_time, is_failed FROM wallet_signature
    WHERE wallet = ?1 AND signature = ?2";

/// One signature listed for a wallet.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ListedSignature {
    /// The transaction signature.
    pub signature: Signature,
    /// The slot it landed in.
    pub slot: u64,
    /// Its rank among the wallet's signatures of the same slot, as listed (0 = the newest), or
    /// `None` until a listing ranks it. A fetched transaction carries its exact index in its
    /// block; this rank only orders the ones not fetched yet.
    pub slot_order: Option<u32>,
    /// When its block was produced, if the node said so.
    pub block_time: Option<Timestamp>,
    /// Whether the transaction failed (it still paid its fee).
    pub is_failed: bool,
}

/// Reads and writes the listed signatures. Get one with [`Store::signatures`].
#[derive(Debug, Clone)]
pub struct SignaturesRepo {
    pub(super) database: Database,
}

impl Store {
    /// The signatures listed for the tracked wallets.
    pub fn signatures(&self) -> SignaturesRepo {
        SignaturesRepo {
            database: self.database().clone(),
        }
    }
}

impl SignaturesRepo {
    /// The signature as listed for `wallet`, if it was.
    ///
    /// # Errors
    ///
    /// Returns an error if the database cannot be read or holds an invalid row.
    pub async fn get(
        &self,
        wallet: Address,
        signature: Signature,
    ) -> Result<Option<ListedSignature>, StoreError> {
        self.database
            .read(move |connection| {
                connection
                    .query_row(
                        SELECT_SIGNATURE,
                        params![wallet.to_string(), signature.to_string()],
                        |row| Ok(signature_from_row(signature, row)),
                    )
                    .optional()?
                    .transpose()
            })
            .await
    }
}

fn signature_from_row(signature: Signature, row: &Row<'_>) -> Result<ListedSignature, StoreError> {
    Ok(ListedSignature {
        signature,
        slot: unsigned_from_sql(row.get(0)?, "slot")?,
        slot_order: row
            .get::<_, Option<i64>>(1)?
            .map(|rank| u32_from_sql(rank, "slot order"))
            .transpose()?,
        block_time: row
            .get::<_, Option<i64>>(2)?
            .map(timestamp_from_sql)
            .transpose()?,
        is_failed: flag_from_sql(row.get(3)?, "failure flag")?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::database::test_database::assert_queries_prepare;

    #[tokio::test]
    async fn prepares_every_query_against_the_schema() {
        assert_queries_prepare(&[SELECT_SIGNATURE]).await;
    }
}
