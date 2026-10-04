//! How a wallet's listed transactions stand in the fetch queue, counted per state.
//!
//! The counts feed the sync status: how much of a wallet's history is in the registry and how
//! much still waits. This module only counts.

use binsight_solana::Address;
use rusqlite::Connection;

use crate::database::codec::unsigned_from_sql;
use crate::error::StoreError;

const COUNT_LISTED: &str = "SELECT count(*) FROM wallet_signature WHERE wallet = ?1";
const COUNT_BY_STATE: &str = "
    SELECT f.state, count(*) FROM wallet_signature s JOIN tx_fetch f ON f.signature = s.signature
    WHERE s.wallet = ?1 GROUP BY f.state";

/// How a wallet's listed transactions stand in the fetch queue.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct FetchCounts {
    /// Signatures listed for the wallet.
    pub listed: u64,
    /// Waiting for a first attempt, or for another after a passing failure.
    pub pending: u64,
    /// Waiting because the node did not have them yet.
    pub empty_retry: u64,
    /// Out of attempts, still tried again from time to time.
    pub failed: u64,
    /// Parked: the node cannot return their version.
    pub unsupported_version: u64,
    /// In the registry.
    pub fetched: u64,
}

/// Counts `wallet`'s listed signatures, then its fetch tasks per state.
pub(super) fn count_states(
    connection: &Connection,
    wallet: Address,
) -> Result<FetchCounts, StoreError> {
    let wallet = wallet.to_string();
    let listed: i64 = connection.query_row(COUNT_LISTED, [&wallet], |row| row.get(0))?;
    let mut counts = FetchCounts {
        listed: unsigned_from_sql(listed, "count")?,
        ..FetchCounts::default()
    };
    let mut query = connection.prepare(COUNT_BY_STATE)?;
    let mut rows = query.query([&wallet])?;
    while let Some(row) = rows.next()? {
        let state: String = row.get(0)?;
        let count = unsigned_from_sql(row.get(1)?, "count")?;
        let field = match state.as_str() {
            "pending" => &mut counts.pending,
            "empty_retry" => &mut counts.empty_retry,
            "failed" => &mut counts.failed,
            "unsupported_version" => &mut counts.unsupported_version,
            "fetched" => &mut counts.fetched,
            _ => {
                return Err(StoreError::InvalidStoredValue {
                    what: "fetch state",
                    value: state,
                });
            }
        };
        *field = count;
    }
    Ok(counts)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::database::test_database::assert_queries_prepare;

    #[tokio::test]
    async fn prepares_every_query_against_the_schema() {
        assert_queries_prepare(&[COUNT_LISTED, COUNT_BY_STATE]).await;
    }
}
