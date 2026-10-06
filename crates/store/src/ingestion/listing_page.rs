//! Writing a listed page of a wallet's signatures, with their fetch tasks and the cursor move.
//!
//! Recording a page is one transaction: the signatures, a pending fetch task for each one not
//! already queued, and the wallet's new cursor, written only if the cursor is still the one the
//! page was listed from. If any part fails, nothing is written, so the cursor never passes a
//! signature the database does not hold. This module stores pages; which page to list and where
//! the cursor goes are the engine's decisions.

use binsight_core::credits::Priority;
use binsight_solana::Address;
use jiff::Timestamp;
use rusqlite::{Connection, params};

use super::cursor::{WalletCursor, cursor_to_sql};
use super::signatures::{ListedSignature, SignaturesRepo};
use crate::database::codec::{flag_to_sql, timestamp_to_sql, unsigned_to_sql};
use crate::error::StoreError;

const INSERT_SIGNATURE: &str = "
    INSERT INTO wallet_signature (wallet, signature, slot, block_time, is_failed, listed_at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6)
    ON CONFLICT (wallet, signature) DO NOTHING";
const FINALIZE_SIGNATURE: &str = "
    UPDATE wallet_signature SET slot = ?3, block_time = coalesce(?4, block_time), is_failed = ?5
    WHERE wallet = ?1 AND signature = ?2";
const INSERT_FETCH_TASK: &str = "
    INSERT INTO tx_fetch (signature, state, priority, slot, attempts, next_attempt_at,
                          last_error, updated_at)
    VALUES (?1, 'pending', ?2, ?3, 0, ?4, NULL, ?4)
    ON CONFLICT (signature) DO UPDATE SET slot = excluded.slot
    WHERE tx_fetch.slot != excluded.slot";
const UPDATE_CURSOR: &str = "
    UPDATE wallet_cursor
    SET top_signature = ?2, top_slot = ?3, history_before = ?4, history_state = ?5,
        listed_count = listed_count + ?10
    WHERE wallet = ?1 AND top_signature IS ?6 AND top_slot IS ?7 AND history_before IS ?8
          AND history_state = ?9";
const SELECT_WALLET: &str = "SELECT count(*) FROM wallet WHERE address = ?1";

/// A listed page of a wallet's signatures and where the wallet's cursor goes after it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ListingPage {
    /// The wallet.
    pub wallet: Address,
    /// The signatures of the page.
    pub signatures: Vec<ListedSignature>,
    /// The wallet's cursor as it was read before listing the page; the page is refused if the
    /// cursor moved meanwhile.
    pub previous_cursor: WalletCursor,
    /// The wallet's cursor once the page is written.
    pub cursor: WalletCursor,
    /// How urgent fetching the new signatures is.
    pub fetch_priority: Priority,
    /// When the page was listed; the new fetch tasks are due from then.
    pub listed_at: Timestamp,
}

impl SignaturesRepo {
    /// Writes a listed page, its fetch tasks and the cursor move, all or nothing. A signature
    /// already recorded (seen first by the live stream, at a lower commitment) takes the page's
    /// slot, block time and outcome. Returns how many of the page's signatures were new for the
    /// wallet.
    ///
    /// # Errors
    ///
    /// Returns [`StoreError::UnknownWallet`] if the wallet is not tracked,
    /// [`StoreError::CursorMoved`] if its cursor is no longer `previous_cursor` (another writer
    /// moved it), or another error if the database cannot be written; nothing is written then.
    pub async fn record_listing(&self, page: ListingPage) -> Result<u64, StoreError> {
        self.database
            .write(move |connection| {
                let transaction = connection.transaction()?;
                let new_signatures = write_page(&transaction, &page)?;
                transaction.commit()?;
                Ok(new_signatures)
            })
            .await
    }
}

/// Writes the signatures, their tasks and the cursor; the caller commits.
fn write_page(connection: &Connection, page: &ListingPage) -> Result<u64, StoreError> {
    let wallet = page.wallet.to_string();
    let listed_at = timestamp_to_sql(page.listed_at);
    let mut new_signatures: u64 = 0;
    for listed in &page.signatures {
        let signature = listed.signature.to_string();
        let slot = unsigned_to_sql(listed.slot, "slot")?;
        let block_time = listed.block_time.map(timestamp_to_sql);
        let is_failed = flag_to_sql(listed.is_failed);
        let inserted = connection.execute(
            INSERT_SIGNATURE,
            params![wallet, signature, slot, block_time, is_failed, listed_at],
        )?;
        if inserted == 1 {
            new_signatures = new_signatures.saturating_add(1);
        } else {
            connection.execute(
                FINALIZE_SIGNATURE,
                params![wallet, signature, slot, block_time, is_failed],
            )?;
        }
        connection.execute(
            INSERT_FETCH_TASK,
            params![signature, page.fetch_priority.as_str(), slot, listed_at],
        )?;
    }
    let (top_signature, top_slot, before, state) = cursor_to_sql(&page.cursor)?;
    let (was_top_signature, was_top_slot, was_before, was_state) =
        cursor_to_sql(&page.previous_cursor)?;
    let updated = connection.execute(
        UPDATE_CURSOR,
        params![
            wallet,
            top_signature,
            top_slot,
            before,
            state,
            was_top_signature,
            was_top_slot,
            was_before,
            was_state,
            unsigned_to_sql(new_signatures, "listed count")?
        ],
    )?;
    if updated != 1 {
        let tracked: i64 = connection.query_row(SELECT_WALLET, [&wallet], |row| row.get(0))?;
        let address = page.wallet;
        return Err(if tracked == 0 {
            StoreError::UnknownWallet { address }
        } else {
            StoreError::CursorMoved { address }
        });
    }
    Ok(new_signatures)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::database::test_database::{assert_queries_prepare, migrated_store};
    use crate::ingestion::test_pages::{
        WALLET, history_page, listed, listed_at, page_after, store_with_wallet,
    };

    #[tokio::test]
    async fn prepares_every_query_against_the_schema() {
        assert_queries_prepare(&[
            INSERT_SIGNATURE,
            FINALIZE_SIGNATURE,
            INSERT_FETCH_TASK,
            UPDATE_CURSOR,
            SELECT_WALLET,
        ])
        .await;
    }

    #[tokio::test]
    async fn writes_listed_signatures_and_the_cursor_in_one_transaction() {
        let (_folder, store) = store_with_wallet().await;
        let page = history_page(WALLET, vec![listed(2, 20), listed(3, 10)]);
        let cursor = page.cursor;

        let new_signatures = store.signatures().record_listing(page).await.unwrap();

        assert_eq!(new_signatures, 2);
        assert_eq!(store.wallets().list().await.unwrap()[0].cursor, cursor);
        let stored = store
            .signatures()
            .get(WALLET, listed(3, 10).signature)
            .await;
        assert_eq!(stored.unwrap(), Some(listed(3, 10)));
        let counts = store.fetch_queue().counts(WALLET).await.unwrap();
        assert_eq!((counts.listed, counts.pending), (2, 2));
    }

    #[tokio::test]
    async fn leaves_the_cursor_unchanged_when_the_listing_write_fails() {
        let (_folder, store) = store_with_wallet().await;
        let impossible_slot = listed(3, u64::MAX);
        let page = history_page(WALLET, vec![listed(2, 20), impossible_slot]);

        let attempt = store.signatures().record_listing(page).await;

        assert!(matches!(attempt, Err(StoreError::ValueTooLarge { .. })));
        assert_eq!(
            store.wallets().list().await.unwrap()[0].cursor,
            WalletCursor::NotStarted
        );
        let counts = store.fetch_queue().counts(WALLET).await.unwrap();
        assert_eq!(counts.listed, 0);
        let due = store
            .fetch_queue()
            .due(listed_at(), 10, Priority::History)
            .await
            .unwrap();
        assert_eq!(due, Vec::new());
    }

    #[tokio::test]
    async fn queues_one_fetch_for_a_transaction_listed_by_two_wallets() {
        let (_folder, store) = store_with_wallet().await;
        let other = Address::from_bytes([9; 32]);
        store.wallets().add(other, listed_at()).await.unwrap();

        for wallet in [WALLET, other] {
            let page = history_page(wallet, vec![listed(2, 20)]);
            assert_eq!(store.signatures().record_listing(page).await.unwrap(), 1);
        }

        let due = store
            .fetch_queue()
            .due(listed_at(), 10, Priority::History)
            .await
            .unwrap();
        assert_eq!(due.len(), 1);
        assert_eq!(store.fetch_queue().counts(other).await.unwrap().listed, 1);
    }

    #[tokio::test]
    async fn counts_a_signature_listed_twice_only_once() {
        let (_folder, store) = store_with_wallet().await;
        let first = history_page(WALLET, vec![listed(2, 20), listed(3, 10)]);
        let overlapping = page_after(&first, vec![listed(3, 10), listed(4, 5)]);

        store.signatures().record_listing(first).await.unwrap();
        let new_signatures = store
            .signatures()
            .record_listing(overlapping)
            .await
            .unwrap();

        assert_eq!(new_signatures, 1);
    }

    #[tokio::test]
    async fn refuses_a_page_for_a_wallet_that_is_not_tracked() {
        let (_folder, store) = migrated_store().await;

        let attempt = store
            .signatures()
            .record_listing(history_page(WALLET, Vec::new()))
            .await;

        assert!(matches!(attempt, Err(StoreError::UnknownWallet { .. })));
    }

    #[tokio::test]
    async fn refuses_a_page_listed_from_a_cursor_that_moved_since() {
        let (_folder, store) = store_with_wallet().await;
        let first = history_page(WALLET, vec![listed(2, 20)]);
        store
            .signatures()
            .record_listing(first.clone())
            .await
            .unwrap();
        let stale = history_page(WALLET, vec![listed(3, 10)]);

        let attempt = store.signatures().record_listing(stale).await;

        assert!(matches!(attempt, Err(StoreError::CursorMoved { .. })));
        assert_eq!(
            store.wallets().list().await.unwrap()[0].cursor,
            first.cursor
        );
        let counts = store.fetch_queue().counts(WALLET).await.unwrap();
        assert_eq!(counts.listed, 1);
    }
}
