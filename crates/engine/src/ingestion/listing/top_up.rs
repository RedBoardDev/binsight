//! Listing what a wallet did since its newest listed signature, page by page, and writing it.
//!
//! A top-up lists from the newest signature down to the cursor's top. Each page is written as
//! soon as it is listed, with its fetch tasks, in one transaction, so a crash loses nothing;
//! signatures the stream already recorded get their rank in their slot. Only the page that
//! reaches the top raises it (`top_up_rules`), to the newest signature the top-up found: the
//! stream never moves the top, only a listing does. A wallet whose history has not started has
//! nothing to top up: its first history page starts from the newest signature anyway.

use binsight_chain::{CallContext, SignaturesRequest};
use binsight_store::{ListedTop, ListingPage, TrackedWallet, WalletCursor};
use jiff::Timestamp;
use tracing::debug;

use super::page_listing::{PageError, list_page};
use super::slot_order::{PageBoundary, rank_in_slots};
use super::top_up_rules::{raise_top, read_top_up_page};
use crate::ingestion::Ingestion;
use crate::ingestion::live::CheckReason;

/// Lists and writes every signature of `wallet` newer than its top, for `reason`; returns when
/// the listing started, which is what the written pages cover.
pub(super) async fn top_up(
    ingestion: &Ingestion,
    wallet: &TrackedWallet,
    reason: CheckReason,
) -> Result<Timestamp, PageError> {
    let started_at = ingestion.clock.now();
    let top = match wallet.cursor {
        WalletCursor::NotStarted => return Ok(started_at),
        WalletCursor::ListingHistory { top, .. } => Some(top),
        WalletCursor::HistoryComplete { top } => top,
    };
    let context = CallContext {
        priority: reason.priority(),
        purpose: reason.purpose(),
        wallet: Some(wallet.address),
    };
    let mut cursor = wallet.cursor;
    let mut before = None;
    let mut boundary: Option<PageBoundary> = None;
    let mut newest: Option<ListedTop> = None;
    loop {
        let request = SignaturesRequest {
            address: wallet.address,
            before,
            until: top.map(|top| top.signature),
        };
        let page = list_page(ingestion, request, context).await?;
        let read = read_top_up_page(top, &page);
        newest = newest.or_else(|| {
            read.newer.first().map(|entry| ListedTop {
                signature: entry.signature,
                slot: entry.slot,
            })
        });
        let next_cursor = match newest {
            Some(newest) if read.reached_top => raise_top(cursor, newest),
            _ => cursor,
        };
        let ranked = rank_in_slots(&read.newer, boundary);
        boundary = ranked.last().and_then(|last| {
            last.slot_order.map(|slot_order| PageBoundary {
                slot: last.slot,
                slot_order,
            })
        });
        if !ranked.is_empty() || next_cursor != cursor {
            let listing = ListingPage {
                wallet: wallet.address,
                signatures: ranked,
                previous_cursor: cursor,
                cursor: next_cursor,
                fetch_priority: reason.priority(),
                listed_at: ingestion.clock.now(),
            };
            let new_signatures = ingestion.store.signatures().record_listing(listing).await?;
            ingestion.new_tasks.notify_one();
            debug!(wallet = %wallet.address, ?reason, new_signatures, "top-up page listed");
            cursor = next_cursor;
        }
        if read.reached_top {
            return Ok(started_at);
        }
        before = page.last().map(|oldest| oldest.signature);
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use binsight_chain::SIGNATURE_PAGE_LIMIT;
    use binsight_chain::test_support::ScriptedReply;
    use binsight_solana::Address;
    use binsight_store::WalletCursor;
    use serde_json::json;

    use crate::test_support::{
        RunningEngine, expect_transactions, numbered_signature, signature_page,
    };

    const WALLET: Address = Address::from_bytes([1; 32]);

    /// The parameters of a top-up page above `until`, older than `before` if given.
    fn top_up_params(until: u16, before: Option<u16>) -> serde_json::Value {
        let mut options = json!({
            "limit": 1_000, "commitment": "finalized",
            "until": numbered_signature(until).to_string()
        });
        if let Some(before) = before {
            options["before"] = json!(numbered_signature(before).to_string());
        }
        json!([WALLET.to_string(), options])
    }

    #[tokio::test(start_paused = true)]
    async fn tops_up_a_restarted_wallet_page_by_page_and_raises_its_top_at_the_end() {
        let setup = crate::test_support::complete_history(&[WALLET], 2_000).await;
        let full = u16::try_from(SIGNATURE_PAGE_LIMIT).unwrap();
        setup
            .transport
            .expect("getSignaturesForAddress")
            .with_params(top_up_params(2_000, None))
            .respond(signature_page(0, full));
        setup
            .transport
            .expect("getSignaturesForAddress")
            .with_params(top_up_params(2_000, Some(full - 1)))
            .respond(signature_page(full, 5));
        expect_transactions(&setup.transport, SIGNATURE_PAGE_LIMIT + 5);
        let engine = RunningEngine::start(setup);

        let counts = engine
            .wait_for_counts(WALLET, |counts| counts.fetched == 1_006)
            .await;
        tokio::time::sleep(Duration::from_secs(60)).await;

        assert_eq!(counts.listed, 1_006);
        let cursor = engine.store.wallets().list().await.unwrap()[0].cursor;
        assert!(
            matches!(cursor, WalletCursor::HistoryComplete { top: Some(top) }
            if top.signature == numbered_signature(0))
        );
        engine.stop().await;
    }

    #[tokio::test(start_paused = true)]
    async fn keeps_the_old_top_when_a_top_up_page_fails() {
        let setup = crate::test_support::complete_history(&[WALLET], 2_000).await;
        let full = u16::try_from(SIGNATURE_PAGE_LIMIT).unwrap();
        setup
            .transport
            .expect("getSignaturesForAddress")
            .with_params(top_up_params(2_000, None))
            .respond(signature_page(0, full));
        for _ in 0..4 {
            setup
                .transport
                .expect("getSignaturesForAddress")
                .with_params(top_up_params(2_000, Some(full - 1)))
                .respond(ScriptedReply::Http {
                    status: 503,
                    retry_after: None,
                    body: "unavailable".to_owned(),
                });
        }
        expect_transactions(&setup.transport, SIGNATURE_PAGE_LIMIT);
        let engine = RunningEngine::start(setup);
        let listings = |engine: &RunningEngine| {
            let calls = engine.transport.calls();
            calls
                .iter()
                .filter(|call| call.method == "getSignaturesForAddress")
                .count()
        };
        while listings(&engine) < 5 {
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        tokio::time::sleep(Duration::from_secs(1)).await;

        let cursor = engine.store.wallets().list().await.unwrap()[0].cursor;
        assert!(
            matches!(cursor, WalletCursor::HistoryComplete { top: Some(top) }
            if top.signature == numbered_signature(2_000))
        );
        let counts = engine.store.fetch_queue().counts(WALLET).await.unwrap();
        assert_eq!(counts.listed, 1_001);
        engine.stop().await;
    }
}
