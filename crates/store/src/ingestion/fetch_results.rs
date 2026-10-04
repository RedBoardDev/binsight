//! Recording what a fetch found: the transaction in the registry, or the task set back.
//!
//! Completing a fetch writes the `raw_tx` row (compressed) and marks the task fetched in one
//! transaction, so the two never disagree. A failed attempt only reschedules its task: a
//! signature is never deleted because the node did not return it. This module applies the
//! engine's decisions; it does not decide when to try again.

use rusqlite::{Connection, params};

use super::fetch_queue::FetchQueueRepo;
use super::fetch_task::{FetchFailure, FetchSetback, FetchedTx};
use crate::database::codec::timestamp_to_sql;
use crate::error::StoreError;
use crate::raw_tx::{RawTxRecord, compress, insert_record};

const MARK_FETCHED: &str = "
    UPDATE tx_fetch
    SET state = 'fetched', attempts = attempts + 1, next_attempt_at = NULL, last_error = NULL,
        updated_at = ?2, max_supported_version = NULL
    WHERE signature = ?1";
const RESCHEDULE: &str = "
    UPDATE tx_fetch
    SET state = ?2, attempts = ?3, next_attempt_at = ?4, last_error = ?5, updated_at = ?6,
        max_supported_version = ?7
    WHERE signature = ?1";

impl FetchQueueRepo {
    /// Stores the fetched transaction in the registry (compressed) and marks its task fetched,
    /// together.
    ///
    /// # Errors
    ///
    /// Returns an error if the payload cannot be compressed or the database cannot be written;
    /// nothing is changed then.
    pub async fn complete(&self, fetched: FetchedTx) -> Result<(), StoreError> {
        self.database
            .write(move |connection| {
                let transaction = connection.transaction()?;
                store_fetched(&transaction, &fetched)?;
                transaction.commit()?;
                Ok(())
            })
            .await
    }

    /// Sets a task back after a failed attempt.
    ///
    /// # Errors
    ///
    /// Returns an error if the database cannot be written.
    pub async fn record_failure(&self, failure: FetchFailure) -> Result<(), StoreError> {
        self.database
            .write(move |connection| {
                let (state, next_attempt_at, max_supported_version) = match failure.setback {
                    FetchSetback::RetryAt { state, at } => {
                        (state.as_sql(), Some(timestamp_to_sql(at)), None)
                    }
                    FetchSetback::UnsupportedVersion {
                        max_supported_version,
                    } => ("unsupported_version", None, Some(max_supported_version)),
                };
                connection.execute(
                    RESCHEDULE,
                    params![
                        failure.signature.to_string(),
                        state,
                        i64::from(failure.attempts),
                        next_attempt_at,
                        failure.error,
                        timestamp_to_sql(failure.updated_at),
                        max_supported_version,
                    ],
                )?;
                Ok(())
            })
            .await
    }
}

/// Inserts the registry row unless it is already there, then marks the task fetched.
fn store_fetched(connection: &Connection, fetched: &FetchedTx) -> Result<(), StoreError> {
    let stored = compress(&fetched.payload)?;
    let record = RawTxRecord {
        signature: fetched.signature,
        slot: fetched.slot,
        block_time: fetched.block_time,
        tx_version: fetched.tx_version,
        commitment: fetched.commitment,
        encoding: fetched.encoding,
        compression: stored.compression,
        payload: stored.bytes,
        payload_sha256: stored.sha256,
        fetched_at: fetched.fetched_at,
    };
    insert_record(connection, &record)?;
    connection.execute(
        MARK_FETCHED,
        params![
            fetched.signature.to_string(),
            timestamp_to_sql(fetched.fetched_at)
        ],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use binsight_core::credits::Priority;
    use binsight_solana::Signature;

    use super::*;
    use crate::database::test_database::assert_queries_prepare;
    use crate::ingestion::RetryState;
    use crate::ingestion::test_pages::{
        WALLET, fetched, history_page, later, listed, listed_at, store_with_wallet,
    };

    #[tokio::test]
    async fn prepares_every_query_against_the_schema() {
        assert_queries_prepare(&[MARK_FETCHED, RESCHEDULE]).await;
    }

    #[tokio::test]
    async fn keeps_raw_tx_and_fetch_state_in_step_when_a_fetch_completes() {
        let (_folder, store) = store_with_wallet().await;
        let page = history_page(WALLET, vec![listed(2, 20)]);
        store.signatures().record_listing(page).await.unwrap();
        let payload = br#"{"slot":20,"transaction":["AQID","base64"],"version":1}"#;

        store
            .fetch_queue()
            .complete(fetched(2, payload))
            .await
            .unwrap();

        let stored = store.raw_tx().payload(Signature::from_bytes([2; 64])).await;
        assert_eq!(stored.unwrap(), Some(payload.to_vec()));
        let counts = store.fetch_queue().counts(WALLET).await.unwrap();
        assert_eq!((counts.fetched, counts.pending), (1, 0));
        assert_eq!(
            store
                .fetch_queue()
                .due(later(60), 10, Priority::History)
                .await
                .unwrap(),
            Vec::new()
        );
        assert_eq!(
            store
                .fetch_queue()
                .next_attempt_at(Priority::History)
                .await
                .unwrap(),
            None
        );
    }

    #[tokio::test]
    async fn never_deletes_a_signature_when_a_fetch_finds_nothing() {
        let (_folder, store) = store_with_wallet().await;
        let page = history_page(WALLET, vec![listed(2, 20)]);
        store.signatures().record_listing(page).await.unwrap();
        let failure = FetchFailure {
            signature: Signature::from_bytes([2; 64]),
            setback: FetchSetback::RetryAt {
                state: RetryState::EmptyRetry,
                at: later(30),
            },
            attempts: 1,
            error: None,
            updated_at: listed_at(),
        };

        store.fetch_queue().record_failure(failure).await.unwrap();

        let counts = store.fetch_queue().counts(WALLET).await.unwrap();
        assert_eq!((counts.listed, counts.empty_retry), (1, 1));
        assert_eq!(
            store
                .fetch_queue()
                .due(later(29), 10, Priority::History)
                .await
                .unwrap(),
            Vec::new()
        );
        let due = store
            .fetch_queue()
            .due(later(30), 10, Priority::History)
            .await
            .unwrap();
        assert_eq!(due[0].attempts, 1);
        assert_eq!(
            store
                .fetch_queue()
                .next_attempt_at(Priority::History)
                .await
                .unwrap(),
            Some(later(30))
        );
    }

    #[tokio::test]
    async fn parks_an_unsupported_version_until_a_newer_binsight_reads_it() {
        let (_folder, store) = store_with_wallet().await;
        let page = history_page(WALLET, vec![listed(2, 20)]);
        store.signatures().record_listing(page).await.unwrap();
        let failure = FetchFailure {
            signature: Signature::from_bytes([2; 64]),
            setback: FetchSetback::UnsupportedVersion {
                max_supported_version: 1,
            },
            attempts: 1,
            error: Some("transaction version 2".to_owned()),
            updated_at: listed_at(),
        };

        store.fetch_queue().record_failure(failure).await.unwrap();

        let queue = store.fetch_queue();
        assert_eq!(queue.counts(WALLET).await.unwrap().unsupported_version, 1);
        assert_eq!(
            queue.next_attempt_at(Priority::History).await.unwrap(),
            None
        );
        assert_eq!(
            queue
                .requeue_unsupported_versions(1, later(60))
                .await
                .unwrap(),
            0
        );

        let requeued = queue.requeue_unsupported_versions(2, later(60)).await;

        assert_eq!(requeued.unwrap(), 1);
        let counts = queue.counts(WALLET).await.unwrap();
        assert_eq!((counts.unsupported_version, counts.pending), (0, 1));
        assert_eq!(
            queue
                .due(later(60), 10, Priority::History)
                .await
                .unwrap()
                .len(),
            1
        );
    }
}
