//! The fixes that restore the registry's invariants from the database alone.
//!
//! None of them calls the network, and none ever queues a transaction the registry already
//! holds: a listed signature whose transaction is stored gets a task marked fetched, a task left
//! open for a stored transaction is marked fetched, and only a task marked fetched without its
//! transaction is queued again. Each fix is one statement, so it applies whole or not at all.
//! This module applies the engine's decisions.

use binsight_core::credits::Priority;
use binsight_solana::Address;
use jiff::Timestamp;
use rusqlite::params;

use super::ConsistencyRepo;
use crate::database::codec::timestamp_to_sql;
use crate::error::StoreError;

const RECOUNT_LISTED: &str = "
    UPDATE wallet_cursor
    SET listed_count = (SELECT count(*) FROM wallet_signature AS s WHERE s.wallet = ?1)
    WHERE wallet = ?1";
const QUEUE_UNQUEUED: &str = "
    INSERT INTO tx_fetch (signature, state, priority, slot, attempts, next_attempt_at,
                          last_error, updated_at)
    SELECT s.signature, 'pending', ?1, max(s.slot), 0, ?2, NULL, ?2 FROM wallet_signature AS s
    WHERE NOT EXISTS (SELECT 1 FROM tx_fetch AS f WHERE f.signature = s.signature)
      AND NOT EXISTS (SELECT 1 FROM raw_tx AS r WHERE r.signature = s.signature)
    GROUP BY s.signature";
const MARK_UNQUEUED_STORED: &str = "
    INSERT INTO tx_fetch (signature, state, priority, slot, attempts, next_attempt_at,
                          last_error, updated_at)
    SELECT s.signature, 'fetched', ?1, max(s.slot), 0, NULL, NULL, ?2 FROM wallet_signature AS s
    WHERE NOT EXISTS (SELECT 1 FROM tx_fetch AS f WHERE f.signature = s.signature)
      AND EXISTS (SELECT 1 FROM raw_tx AS r WHERE r.signature = s.signature)
    GROUP BY s.signature";
const MARK_STORED_FETCHED: &str = "
    UPDATE tx_fetch
    SET state = 'fetched', next_attempt_at = NULL, last_error = NULL,
        max_supported_version = NULL, updated_at = ?1
    WHERE state <> 'fetched'
      AND EXISTS (SELECT 1 FROM raw_tx AS r WHERE r.signature = tx_fetch.signature)";
const REQUEUE_WITHOUT_PAYLOAD: &str = "
    UPDATE tx_fetch
    SET state = 'pending', priority = ?1, attempts = 0, next_attempt_at = ?2, last_error = NULL,
        updated_at = ?2
    WHERE state = 'fetched'
      AND NOT EXISTS (SELECT 1 FROM raw_tx AS r WHERE r.signature = tx_fetch.signature)";

impl ConsistencyRepo {
    /// Sets `wallet`'s counter of listed signatures to the number of its listed rows.
    ///
    /// # Errors
    ///
    /// Returns an error if the database cannot be written.
    pub async fn recount_listed(&self, wallet: Address) -> Result<(), StoreError> {
        self.database
            .write(move |connection| {
                connection.execute(RECOUNT_LISTED, [wallet.to_string()])?;
                Ok(())
            })
            .await
    }

    /// Gives every listed signature without a fetch task one: due at `now` with `priority`, or
    /// already fetched when the registry holds its transaction. Returns how many were queued to
    /// be fetched.
    ///
    /// # Errors
    ///
    /// Returns an error if the database cannot be written; nothing is changed then.
    pub async fn queue_unqueued_signatures(
        &self,
        priority: Priority,
        now: Timestamp,
    ) -> Result<u64, StoreError> {
        self.database
            .write(move |connection| {
                let transaction = connection.transaction()?;
                let parameters = params![priority.as_str(), timestamp_to_sql(now)];
                transaction.execute(MARK_UNQUEUED_STORED, parameters)?;
                let queued = transaction.execute(QUEUE_UNQUEUED, parameters)?;
                transaction.commit()?;
                Ok(u64::try_from(queued).unwrap_or(u64::MAX))
            })
            .await
    }

    /// Marks fetched every open task whose transaction the registry already holds, so it is
    /// never fetched again. Returns how many.
    ///
    /// # Errors
    ///
    /// Returns an error if the database cannot be written.
    pub async fn mark_stored_fetched(&self, now: Timestamp) -> Result<u64, StoreError> {
        self.database
            .write(move |connection| {
                let marked = connection.execute(MARK_STORED_FETCHED, [timestamp_to_sql(now)])?;
                Ok(u64::try_from(marked).unwrap_or(u64::MAX))
            })
            .await
    }

    /// Queues again, due at `now` with `priority`, every task marked fetched whose transaction
    /// the registry does not hold. Returns how many.
    ///
    /// # Errors
    ///
    /// Returns an error if the database cannot be written.
    pub async fn requeue_fetched_without_payload(
        &self,
        priority: Priority,
        now: Timestamp,
    ) -> Result<u64, StoreError> {
        self.database
            .write(move |connection| {
                let parameters = params![priority.as_str(), timestamp_to_sql(now)];
                let queued = connection.execute(REQUEUE_WITHOUT_PAYLOAD, parameters)?;
                Ok(u64::try_from(queued).unwrap_or(u64::MAX))
            })
            .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::database::test_database::assert_queries_prepare;

    #[tokio::test]
    async fn prepares_every_query_against_the_schema() {
        assert_queries_prepare(&[
            RECOUNT_LISTED,
            QUEUE_UNQUEUED,
            MARK_UNQUEUED_STORED,
            MARK_STORED_FETCHED,
            REQUEUE_WITHOUT_PAYLOAD,
        ])
        .await;
    }
}
