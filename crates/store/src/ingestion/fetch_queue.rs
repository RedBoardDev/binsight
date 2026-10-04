//! The queue of transactions to fetch: which tasks are due, when the next one falls due, how a
//! wallet's transactions stand, and putting back the tasks parked for a version binsight now
//! reads.
//!
//! Tasks are served the most urgent class first, then the newest slots. Recording what a fetch
//! found lives in `fetch_results`. This module reads the queue; it does not decide when to try
//! again.

use binsight_core::credits::Priority;
use binsight_solana::Address;
use jiff::Timestamp;
use rusqlite::{Row, params};

use super::fetch_counts::{FetchCounts, count_states};
use super::fetch_task::FetchTask;
use crate::database::Database;
use crate::database::codec::{
    parse_from_sql, timestamp_from_sql, timestamp_to_sql, u32_from_sql, unsigned_from_sql,
};
use crate::error::StoreError;
use crate::store::Store;

// The unary plus keeps SQLite from serving the query from the next_attempt_at index and sorting
// every due task: the urgency index already yields them in order, and the batch stops at the
// limit.
const SELECT_DUE: &str = "
    SELECT signature, slot, priority, attempts FROM tx_fetch
    WHERE next_attempt_at IS NOT NULL AND +next_attempt_at <= ?1
    ORDER BY (CASE priority WHEN 'realtime' THEN 0 WHEN 'catch_up' THEN 1 ELSE 2 END), slot DESC
    LIMIT ?2";
const SELECT_NEXT_ATTEMPT: &str =
    "SELECT min(next_attempt_at) FROM tx_fetch WHERE next_attempt_at IS NOT NULL";
const REQUEUE_UNSUPPORTED: &str = "
    UPDATE tx_fetch
    SET state = 'pending', next_attempt_at = ?2, max_supported_version = NULL, updated_at = ?2
    WHERE state = 'unsupported_version' AND max_supported_version < ?1";
/// Reads and writes the fetch queue. Get one with [`Store::fetch_queue`].
#[derive(Debug, Clone)]
pub struct FetchQueueRepo {
    pub(super) database: Database,
}

impl Store {
    /// The queue of transactions to fetch.
    pub fn fetch_queue(&self) -> FetchQueueRepo {
        FetchQueueRepo {
            database: self.database().clone(),
        }
    }
}

impl FetchQueueRepo {
    /// At most `limit` tasks due at `now`: the most urgent class first, then the newest slots.
    ///
    /// # Errors
    ///
    /// Returns an error if the database cannot be read or holds an invalid row.
    pub async fn due(&self, now: Timestamp, limit: u32) -> Result<Vec<FetchTask>, StoreError> {
        self.database
            .read(move |connection| {
                let mut query = connection.prepare(SELECT_DUE)?;
                let rows = query
                    .query_map(params![timestamp_to_sql(now), i64::from(limit)], |row| {
                        Ok(task_from_row(row))
                    })?;
                rows.map(|row| row?).collect()
            })
            .await
    }

    /// When the next task falls due, if any task waits.
    ///
    /// # Errors
    ///
    /// Returns an error if the database cannot be read.
    pub async fn next_attempt_at(&self) -> Result<Option<Timestamp>, StoreError> {
        self.database
            .read(|connection| {
                let next: Option<i64> =
                    connection.query_row(SELECT_NEXT_ATTEMPT, [], |row| row.get(0))?;
                next.map(timestamp_from_sql).transpose()
            })
            .await
    }

    /// Puts back in the queue, due at `now`, every task parked because its version was newer
    /// than binsight could read, when `max_supported_version` now reads it. Returns how many.
    ///
    /// # Errors
    ///
    /// Returns an error if the database cannot be written.
    pub async fn requeue_unsupported_versions(
        &self,
        max_supported_version: u8,
        now: Timestamp,
    ) -> Result<u64, StoreError> {
        self.database
            .write(move |connection| {
                let requeued = connection.execute(
                    REQUEUE_UNSUPPORTED,
                    params![max_supported_version, timestamp_to_sql(now)],
                )?;
                Ok(u64::try_from(requeued).unwrap_or(u64::MAX))
            })
            .await
    }

    /// How the transactions listed for `wallet` stand in the queue.
    ///
    /// # Errors
    ///
    /// Returns an error if the database cannot be read or holds an invalid row.
    pub async fn counts(&self, wallet: Address) -> Result<FetchCounts, StoreError> {
        self.database
            .read(move |connection| count_states(connection, wallet))
            .await
    }
}

fn task_from_row(row: &Row<'_>) -> Result<FetchTask, StoreError> {
    Ok(FetchTask {
        signature: parse_from_sql(&row.get::<_, String>(0)?, "signature")?,
        slot: unsigned_from_sql(row.get(1)?, "slot")?,
        priority: parse_from_sql::<Priority>(&row.get::<_, String>(2)?, "priority")?,
        attempts: u32_from_sql(row.get(3)?, "attempt count")?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::database::test_database::assert_queries_prepare;
    use crate::ingestion::test_pages::{
        WALLET, history_page, listed, listed_at, page_after, store_with_wallet,
    };

    #[tokio::test]
    async fn prepares_every_query_against_the_schema() {
        assert_queries_prepare(&[SELECT_DUE, SELECT_NEXT_ATTEMPT, REQUEUE_UNSUPPORTED]).await;
    }

    #[tokio::test]
    async fn reads_the_due_tasks_in_order_from_an_index_without_sorting_them() {
        let (_folder, store) = store_with_wallet().await;

        let plan = store
            .database()
            .read(|connection| {
                let mut query = connection.prepare(&format!("EXPLAIN QUERY PLAN {SELECT_DUE}"))?;
                let steps = query.query_map(params![0, 32], |row| row.get::<_, String>(3))?;
                Ok(steps.collect::<Result<Vec<String>, _>>()?)
            })
            .await
            .unwrap();

        assert!(
            plan.iter().any(|step| step.contains("tx_fetch_by_urgency")),
            "{plan:?}"
        );
        assert!(
            !plan.iter().any(|step| step.contains("TEMP B-TREE")),
            "{plan:?}"
        );
    }

    #[tokio::test]
    async fn serves_due_realtime_fetches_before_history_ones_and_newest_first() {
        let (_folder, store) = store_with_wallet().await;
        let history = history_page(WALLET, vec![listed(2, 30), listed(3, 10)]);
        store
            .signatures()
            .record_listing(history.clone())
            .await
            .unwrap();
        let mut realtime = page_after(&history, vec![listed(4, 20)]);
        realtime.fetch_priority = Priority::Realtime;
        store.signatures().record_listing(realtime).await.unwrap();

        let due = store.fetch_queue().due(listed_at(), 10).await.unwrap();

        let order: Vec<u64> = due.iter().map(|task| task.slot).collect();
        assert_eq!(order, vec![20, 30, 10]);
        assert_eq!(
            store.fetch_queue().due(listed_at(), 1).await.unwrap().len(),
            1
        );
    }
}
