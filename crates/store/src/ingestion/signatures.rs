//! The signatures listed for each wallet.
//!
//! A signature is written with its listed page (`listing_page`), in one transaction with its fetch
//! task and the cursor move. This module names listed signatures; which page to list and where
//! the cursor goes are the engine's decisions.

use binsight_solana::Signature;
use jiff::Timestamp;

use crate::database::Database;
use crate::store::Store;

/// One signature listed for a wallet.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ListedSignature {
    /// The transaction signature.
    pub signature: Signature,
    /// The slot it landed in.
    pub slot: u64,
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

#[cfg(test)]
mod tests {
    use binsight_solana::Address;
    use rusqlite::{OptionalExtension, params};

    use super::*;
    use crate::database::codec::{flag_from_sql, timestamp_from_sql, unsigned_from_sql};
    use crate::database::test_database::assert_queries_prepare;
    use crate::error::StoreError;

    const SELECT_SIGNATURE: &str = "
        SELECT slot, block_time, is_failed FROM wallet_signature
        WHERE wallet = ?1 AND signature = ?2";

    impl SignaturesRepo {
        /// The signature as listed for `wallet`, if it was: what the tests of the crate check.
        pub(crate) async fn get(
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
                            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                        )
                        .optional()?
                        .map(|(slot, block_time, is_failed): (i64, Option<i64>, i64)| {
                            Ok(ListedSignature {
                                signature,
                                slot: unsigned_from_sql(slot, "slot")?,
                                block_time: block_time.map(timestamp_from_sql).transpose()?,
                                is_failed: flag_from_sql(is_failed, "failure flag")?,
                            })
                        })
                        .transpose()
                })
                .await
        }
    }

    #[tokio::test]
    async fn prepares_every_query_against_the_schema() {
        assert_queries_prepare(&[SELECT_SIGNATURE]).await;
    }
}
