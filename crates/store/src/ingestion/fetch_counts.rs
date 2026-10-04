//! How a wallet's listed transactions stand in the fetch queue, counted per state, and what
//! keeps its registry behind.
//!
//! The counts feed the sync status: how much of a wallet's history is in the registry and how
//! much still waits, and how old the oldest live work waiting is. This module only counts.

use binsight_solana::Address;
use jiff::Timestamp;
use rusqlite::Connection;

use crate::database::codec::{timestamp_from_sql, unsigned_from_sql};
use crate::error::StoreError;

const COUNT_LISTED: &str = "SELECT count(*) FROM wallet_signature WHERE wallet = ?1";
const COUNT_BY_STATE: &str = "
    SELECT f.state, count(*) FROM wallet_signature s JOIN tx_fetch f ON f.signature = s.signature
    WHERE s.wallet = ?1 GROUP BY f.state";
const SELECT_BACKLOG: &str = "
    SELECT
        coalesce(sum(f.priority = 'history' AND f.state IN ('pending', 'empty_retry')), 0),
        coalesce(sum(f.state = 'failed'), 0),
        min(CASE WHEN f.priority <> 'history' AND f.state IN ('pending', 'empty_retry')
                 THEN f.next_attempt_at END)
    FROM wallet_signature s JOIN tx_fetch f ON f.signature = s.signature
    WHERE s.wallet = ?1";

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

/// What keeps a wallet's registry behind.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct WalletBacklog {
    /// Transactions of the history import not fetched yet.
    pub history_unfetched: u64,
    /// Transactions whose attempts ran out (still tried again daily).
    pub failed: u64,
    /// When the oldest live or catch-up fetch waiting fell due, if one waits.
    pub oldest_live_due_at: Option<Timestamp>,
}

/// Reads what keeps `wallet`'s registry behind.
pub(super) fn read_backlog(
    connection: &Connection,
    wallet: Address,
) -> Result<WalletBacklog, StoreError> {
    let (history_unfetched, failed, oldest): (i64, i64, Option<i64>) =
        connection.query_row(SELECT_BACKLOG, [wallet.to_string()], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        })?;
    Ok(WalletBacklog {
        history_unfetched: unsigned_from_sql(history_unfetched, "count")?,
        failed: unsigned_from_sql(failed, "count")?,
        oldest_live_due_at: oldest.map(timestamp_from_sql).transpose()?,
    })
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
        assert_queries_prepare(&[COUNT_LISTED, COUNT_BY_STATE, SELECT_BACKLOG]).await;
    }
}
