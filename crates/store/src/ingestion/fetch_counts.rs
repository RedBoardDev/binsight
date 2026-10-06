//! How a wallet's listed transactions stand in the fetch queue, counted per state, and what
//! keeps each wallet's registry behind.
//!
//! The backlog feeds the sync status: how much of each wallet's history still waits, what keeps
//! failing, and how old the oldest live work waiting is. It is read from the open tasks only
//! (an index holds them), so its cost follows the work left, not the history. The full counts
//! walk a wallet's whole history; only the administration command asks for them. This module
//! only counts.

use std::collections::BTreeMap;

use binsight_solana::Address;
use jiff::Timestamp;
use rusqlite::Connection;

use crate::database::codec::{parse_from_sql, timestamp_from_sql, unsigned_from_sql};
use crate::error::StoreError;

const COUNT_LISTED: &str = "SELECT count(*) FROM wallet_signature WHERE wallet = ?1";
const COUNT_BY_STATE: &str = "
    SELECT f.state, count(*) FROM wallet_signature s JOIN tx_fetch f ON f.signature = s.signature
    WHERE s.wallet = ?1 GROUP BY f.state";
// The open tasks drive the query, through their partial index, and find their wallets through the
// signature index: CROSS JOIN fixes that order, which SQLite would otherwise pick from table
// sizes it does not know, and could turn into a walk of every listed signature.
const SELECT_BACKLOGS: &str = "
    SELECT
        s.wallet,
        sum(f.priority = 'history' AND f.state IN ('pending', 'empty_retry')),
        sum(f.state = 'failed'),
        sum(f.state = 'unsupported_version'),
        min(CASE WHEN f.priority <> 'history' AND f.state IN ('pending', 'empty_retry')
                 THEN f.next_attempt_at END)
    FROM tx_fetch AS f INDEXED BY tx_fetch_open
    CROSS JOIN wallet_signature AS s ON s.signature = f.signature
    WHERE f.state <> 'fetched'
    GROUP BY s.wallet";

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
    /// Parked transactions which this binary cannot read.
    pub unsupported_version: u64,
    /// When the oldest live or catch-up fetch waiting fell due, if one waits.
    pub oldest_live_due_at: Option<Timestamp>,
}

/// Reads what keeps each wallet's registry behind; a wallet without open work is left out.
pub(super) fn read_backlogs(
    connection: &Connection,
) -> Result<BTreeMap<Address, WalletBacklog>, StoreError> {
    let mut query = connection.prepare(SELECT_BACKLOGS)?;
    let mut rows = query.query([])?;
    let mut backlogs = BTreeMap::new();
    while let Some(row) = rows.next()? {
        let wallet = parse_from_sql(&row.get::<_, String>(0)?, "wallet address")?;
        let oldest: Option<i64> = row.get(4)?;
        let backlog = WalletBacklog {
            history_unfetched: unsigned_from_sql(row.get(1)?, "count")?,
            failed: unsigned_from_sql(row.get(2)?, "count")?,
            unsupported_version: unsigned_from_sql(row.get(3)?, "count")?,
            oldest_live_due_at: oldest.map(timestamp_from_sql).transpose()?,
        };
        backlogs.insert(wallet, backlog);
    }
    Ok(backlogs)
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
    use crate::database::test_database::{assert_queries_prepare, migrated_store};

    #[tokio::test]
    async fn prepares_every_query_against_the_schema() {
        assert_queries_prepare(&[COUNT_LISTED, COUNT_BY_STATE, SELECT_BACKLOGS]).await;
    }

    #[tokio::test]
    async fn reads_the_backlogs_from_the_open_tasks_only() {
        let (_folder, store) = migrated_store().await;
        let plan = store
            .database()
            .read(|connection| {
                let mut query =
                    connection.prepare(&format!("EXPLAIN QUERY PLAN {SELECT_BACKLOGS}"))?;
                let rows = query.query_map([], |row| row.get::<_, String>(3))?;
                Ok(rows.collect::<Result<Vec<_>, _>>()?)
            })
            .await
            .unwrap();
        let uses = |index: &str| plan.iter().any(|step| step.contains(index));
        assert!(uses("tx_fetch_open"), "{plan:?}");
        assert!(uses("wallet_signature_by_signature"), "{plan:?}");
        assert!(!uses("SCAN s"), "{plan:?}");
    }
}
