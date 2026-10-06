//! Recording a signature the live stream saw, before any listing finds it.
//!
//! The stream reports a signature seconds after it is confirmed; it is written for its wallet,
//! without a block time (a later listing gives it one), and its fetch task is queued as
//! live work, due when the transaction should be final. A signature already queued for the
//! history import is raised to live work and brought forward. This module only stores; the
//! stream never moves a cursor, so it writes none.

use binsight_solana::{Address, Signature};
use jiff::Timestamp;
use rusqlite::params;

use super::signatures::SignaturesRepo;
use crate::database::codec::{flag_to_sql, timestamp_to_sql, unsigned_to_sql};
use crate::error::StoreError;

const INSERT_DETECTED: &str = "
    INSERT INTO wallet_signature (wallet, signature, slot, block_time, is_failed, listed_at)
    VALUES (?1, ?2, ?3, NULL, ?4, ?5)
    ON CONFLICT (wallet, signature) DO NOTHING";
const QUEUE_LIVE_FETCH: &str = "
    INSERT INTO tx_fetch (signature, state, priority, slot, attempts, next_attempt_at,
                          last_error, updated_at)
    VALUES (?1, 'pending', 'realtime', ?2, 0, ?3, NULL, ?4)
    ON CONFLICT (signature) DO UPDATE
    SET priority = 'realtime', next_attempt_at = min(next_attempt_at, excluded.next_attempt_at),
        updated_at = excluded.updated_at
    WHERE next_attempt_at IS NOT NULL";

/// A signature the live stream saw for a wallet.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DetectedSignature {
    /// The wallet it mentions.
    pub wallet: Address,
    /// The transaction signature.
    pub signature: Signature,
    /// The slot it was confirmed in.
    pub slot: u64,
    /// Whether it failed.
    pub is_failed: bool,
    /// When the stream reported it.
    pub detected_at: Timestamp,
    /// When to fetch it: once it should be final.
    pub fetch_at: Timestamp,
}

impl SignaturesRepo {
    /// Records a signature the stream saw and queues its fetch as live work, together. Returns
    /// whether the signature was new for the wallet.
    ///
    /// # Errors
    ///
    /// Returns an error if the wallet is not tracked or the database cannot be written; nothing
    /// is written then.
    pub async fn record_detected(&self, detected: DetectedSignature) -> Result<bool, StoreError> {
        self.database
            .write(move |connection| {
                let transaction = connection.transaction()?;
                let signature = detected.signature.to_string();
                let slot = unsigned_to_sql(detected.slot, "slot")?;
                let detected_at = timestamp_to_sql(detected.detected_at);
                let inserted = transaction.execute(
                    INSERT_DETECTED,
                    params![
                        detected.wallet.to_string(),
                        signature,
                        slot,
                        flag_to_sql(detected.is_failed),
                        detected_at,
                    ],
                )?;
                transaction.execute(
                    QUEUE_LIVE_FETCH,
                    params![
                        signature,
                        slot,
                        timestamp_to_sql(detected.fetch_at),
                        detected_at
                    ],
                )?;
                transaction.commit()?;
                Ok(inserted == 1)
            })
            .await
    }
}

#[cfg(test)]
mod tests {
    use binsight_core::credits::Priority;

    use super::*;
    use crate::database::test_database::assert_queries_prepare;
    use crate::ingestion::test_pages::{
        WALLET, history_page, later, listed, listed_at, page_after, store_with_wallet,
    };

    fn detected(seed: u8, fetch_at: Timestamp) -> DetectedSignature {
        DetectedSignature {
            wallet: WALLET,
            signature: Signature::from_bytes([seed; 64]),
            slot: 20,
            is_failed: true,
            detected_at: listed_at(),
            fetch_at,
        }
    }

    #[tokio::test]
    async fn prepares_every_query_against_the_schema() {
        assert_queries_prepare(&[INSERT_DETECTED, QUEUE_LIVE_FETCH]).await;
    }

    #[tokio::test]
    async fn queues_a_streamed_signature_as_live_work_without_a_block_time() {
        let (_folder, store) = store_with_wallet().await;

        let is_new = store
            .signatures()
            .record_detected(detected(2, later(13)))
            .await
            .unwrap();

        assert!(is_new);
        let stored = store
            .signatures()
            .get(WALLET, listed(2, 20).signature)
            .await;
        let stored = stored.unwrap().unwrap();
        assert_eq!(stored.block_time, None);
        assert!(stored.is_failed);
        let queue = store.fetch_queue();
        assert_eq!(
            queue.due(later(12), 10, Priority::History).await.unwrap(),
            Vec::new()
        );
        let due = queue.due(later(13), 10, Priority::Realtime).await.unwrap();
        assert_eq!(due.len(), 1);
        assert_eq!(due[0].priority, Priority::Realtime);
    }

    #[tokio::test]
    async fn raises_the_priority_of_a_history_signature_seen_by_the_stream() {
        let (_folder, store) = store_with_wallet().await;
        let mut history = history_page(WALLET, vec![listed(9, 30)]);
        history.listed_at = later(600);
        store.signatures().record_listing(history).await.unwrap();

        let is_new = store
            .signatures()
            .record_detected(detected(9, later(13)))
            .await
            .unwrap();

        assert!(!is_new);
        let due = store
            .fetch_queue()
            .due(later(13), 10, Priority::Realtime)
            .await
            .unwrap();
        assert_eq!(due.len(), 1);
    }

    #[tokio::test]
    async fn takes_the_finalized_listing_of_a_streamed_signature() {
        let (_folder, store) = store_with_wallet().await;
        let records = store.signatures();
        records
            .record_detected(detected(2, later(13)))
            .await
            .unwrap();

        let first = history_page(WALLET, vec![listed(3, 40)]);
        records.record_listing(first.clone()).await.unwrap();
        records
            .record_listing(page_after(&first, vec![listed(2, 20)]))
            .await
            .unwrap();

        let stored = records.get(WALLET, listed(2, 20).signature).await.unwrap();
        let stored = stored.unwrap();
        assert_eq!(stored, listed(2, 20));
    }

    #[tokio::test]
    async fn tells_the_history_left_to_fetch_from_the_live_work_waiting() {
        let (_folder, store) = store_with_wallet().await;
        let history = history_page(WALLET, vec![listed(3, 40), listed(4, 10)]);
        store.signatures().record_listing(history).await.unwrap();
        store
            .signatures()
            .record_detected(detected(2, later(13)))
            .await
            .unwrap();

        let backlog = store.fetch_queue().backlog(WALLET).await.unwrap();

        assert_eq!(backlog.history_unfetched, 2);
        assert_eq!(backlog.failed, 0);
        assert_eq!(backlog.oldest_live_due_at, Some(later(13)));
    }
}
