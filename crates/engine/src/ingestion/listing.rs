//! The listing worker: lists the history of each tracked wallet, one page at a time, until it is
//! complete.
//!
//! The worker lists the page of the wallet due first (`history_schedule`), then the next one. A
//! page that cannot be listed or written changes nothing; its wallet waits before trying again
//! while the others go on. A credit budget that defers history listings, or a refusal that
//! concerns every request, makes the whole worker wait. Listing and writing one page is `history_page`'s job.

mod history_cursor;
mod history_end;
mod history_page;
mod history_schedule;
mod slot_order;

use std::time::Duration;

use tokio_util::sync::CancellationToken;
use tracing::{debug, error, warn};

use super::Ingestion;
use super::refusal::{report_pause, time_until};
use history_page::{PageError, list_and_write};
use history_schedule::{ListingSchedule, NextListing};

/// How long to wait after the tracked wallets could not be read.
const STORE_RETRY_DELAY: Duration = Duration::from_secs(30);

/// From this many failures in a row, a wallet's failing page is reported as an error: it is not
/// healing by itself, and a human should look.
const FAILURES_BEFORE_ALERT: u32 = 5;

/// How the latest listing step ended.
enum Progress {
    /// Look for the next page to list at once.
    Continue,
    /// Every tracked wallet's history is complete.
    NothingToList,
    /// Nothing is due; look again after this delay.
    Wait(Duration),
}

/// Lists pages until every history is complete or `shutdown` is cancelled.
pub(super) async fn run_listing(ingestion: &Ingestion, shutdown: &CancellationToken) {
    let mut schedule = ListingSchedule::default();
    loop {
        let progress = tokio::select! {
            () = shutdown.cancelled() => return,
            progress = list_next_page(ingestion, &mut schedule) => progress,
        };
        match progress {
            Progress::Continue => {}
            Progress::NothingToList => {
                debug!("every tracked history is listed");
                return;
            }
            Progress::Wait(delay) => {
                tokio::select! {
                    () = shutdown.cancelled() => return,
                    () = tokio::time::sleep(delay) => {}
                }
            }
        }
    }
}

/// Lists and writes the page of the wallet due first, if one is due.
async fn list_next_page(ingestion: &Ingestion, schedule: &mut ListingSchedule) -> Progress {
    let wallets = match ingestion.store.wallets().list().await {
        Ok(wallets) => wallets,
        Err(error) => {
            error!(%error, "could not read the tracked wallets");
            return Progress::Wait(STORE_RETRY_DELAY);
        }
    };
    let now = ingestion.clock.now();
    let (wallet, request) = match schedule.next(&wallets, now) {
        NextListing::Nothing => return Progress::NothingToList,
        NextListing::WaitUntil(due_at) => return Progress::Wait(time_until(now, due_at)),
        NextListing::List { wallet, request } => (wallet, request),
    };
    let unconfirmed_end = schedule.unconfirmed_end(wallet.address).cloned();
    match list_and_write(ingestion, wallet, request, unconfirmed_end.as_ref()).await {
        Ok(end) => schedule.record_page(wallet.address, end, ingestion.clock.now()),
        Err(PageError::Deferred { until }) => {
            debug!(%until, "history listing deferred by the credit budget");
            return Progress::Wait(time_until(ingestion.clock.now(), until));
        }
        Err(PageError::Paused { until, reason }) => {
            report_pause("listing", &reason, until);
            return Progress::Wait(time_until(ingestion.clock.now(), until));
        }
        Err(error) => {
            let (failures, retry_at) =
                schedule.record_failure(wallet.address, ingestion.clock.now());
            if failures >= FAILURES_BEFORE_ALERT {
                error!(wallet = %wallet.address, %error, failures, %retry_at, "a history page keeps failing");
            } else {
                warn!(wallet = %wallet.address, %error, failures, %retry_at, "could not list a history page; trying again later");
            }
        }
    }
    Progress::Continue
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use binsight_chain::SIGNATURE_PAGE_LIMIT;
    use binsight_chain::test_support::ScriptedReply;
    use binsight_solana::Address;
    use binsight_store::WalletCursor;
    use serde_json::json;

    use binsight_core::credits::Credits;

    use crate::test_support::{
        RunningEngine, TEST_START, expect_transactions, numbered_signature, record_spent_today,
        signature_page, temporary_engine,
    };

    const WALLET: Address = Address::from_bytes([1; 32]);

    #[tokio::test(start_paused = true)]
    async fn lists_every_page_of_a_history_and_fetches_each_transaction_once() {
        let setup = temporary_engine().await;
        setup.store.wallets().add(WALLET, TEST_START).await.unwrap();
        let full = u16::try_from(SIGNATURE_PAGE_LIMIT).unwrap();
        let listing = setup.transport.expect("getSignaturesForAddress");
        listing.respond(signature_page(0, full));
        for _listing_and_its_confirmation in 0..2 {
            let listing = setup.transport.expect("getSignaturesForAddress");
            listing.respond(signature_page(full, 2));
        }
        expect_transactions(&setup.transport, SIGNATURE_PAGE_LIMIT + 2);
        let engine = RunningEngine::start(setup);

        let cursor = engine.wait_for_complete_history(WALLET).await;
        let counts = engine
            .wait_for_counts(WALLET, |counts| counts.fetched == 1_002)
            .await;

        assert_eq!(counts.listed, 1_002);
        assert!(
            matches!(cursor, WalletCursor::HistoryComplete { top: Some(top) }
            if top.signature == numbered_signature(0))
        );
        let listings: Vec<_> = engine
            .transport
            .calls()
            .into_iter()
            .filter(|call| call.method == "getSignaturesForAddress")
            .collect();
        let oldest_of_first_page = numbered_signature(full - 1).to_string();
        assert_eq!(listings.len(), 3);
        assert_eq!(listings[1].params[1]["before"], oldest_of_first_page);
        assert_eq!(listings[2].params, listings[1].params);
        assert_eq!(engine.store.raw_tx().count().await.unwrap(), 1_002);
        engine.stop().await;
    }

    #[tokio::test(start_paused = true)]
    async fn never_reads_a_failed_listing_as_genesis() {
        let setup = temporary_engine().await;
        setup.store.wallets().add(WALLET, TEST_START).await.unwrap();
        for _ in 0..4 {
            setup
                .transport
                .expect("getSignaturesForAddress")
                .respond(ScriptedReply::Http {
                    status: 503,
                    retry_after: None,
                    body: "unavailable".to_owned(),
                });
        }
        let engine = RunningEngine::start(setup);
        tokio::time::sleep(Duration::from_secs(20)).await;

        let cursor = engine.store.wallets().list().await.unwrap()[0].cursor;
        assert_eq!(cursor, WalletCursor::NotStarted);
        let listing = engine.transport.expect("getSignaturesForAddress");
        listing.respond(signature_page(0, 1));
        expect_transactions(&engine.transport, 1);
        let counts = engine
            .wait_for_counts(WALLET, |counts| counts.fetched == 1)
            .await;
        assert_eq!(counts.listed, 1);
        engine.stop().await;
    }

    #[tokio::test(start_paused = true)]
    async fn keeps_listing_the_other_wallets_while_one_page_keeps_failing() {
        let stuck = Address::from_bytes([0; 32]);
        let setup = temporary_engine().await;
        setup.store.wallets().add(stuck, TEST_START).await.unwrap();
        setup.store.wallets().add(WALLET, TEST_START).await.unwrap();
        let first_page = |wallet: Address| json!([wallet.to_string(), {"limit": 1_000, "commitment": "finalized"}]);
        let failing_attempts_in_1000_secs = 6;
        for _ in 0..failing_attempts_in_1000_secs {
            setup
                .transport
                .expect("getSignaturesForAddress")
                .with_params(first_page(stuck))
                .respond(ScriptedReply::Result(json!("not a page")));
        }
        for _listing_and_its_confirmation in 0..2 {
            setup
                .transport
                .expect("getSignaturesForAddress")
                .with_params(first_page(WALLET))
                .respond(signature_page(0, 2));
        }
        expect_transactions(&setup.transport, 2);
        let engine = RunningEngine::start(setup);

        engine.wait_for_complete_history(WALLET).await;
        engine
            .wait_for_counts(WALLET, |counts| counts.fetched == 2)
            .await;
        tokio::time::sleep(Duration::from_secs(1_000)).await;

        let stuck_listings = engine
            .transport
            .calls()
            .iter()
            .filter(|call| call.params == first_page(stuck))
            .count();
        assert_eq!(stuck_listings, failing_attempts_in_1000_secs);
        let cursors: Vec<_> = engine.store.wallets().list().await.unwrap();
        assert_eq!(cursors[0].cursor, WalletCursor::NotStarted);
        engine.stop().await;
    }

    #[tokio::test(start_paused = true)]
    async fn keeps_a_history_open_until_a_second_listing_finds_the_same_end() {
        let setup = temporary_engine().await;
        setup.store.wallets().add(WALLET, TEST_START).await.unwrap();
        for page in [
            signature_page(0, 2),
            signature_page(0, 3),
            signature_page(0, 3),
        ] {
            setup
                .transport
                .expect("getSignaturesForAddress")
                .respond(page);
        }
        expect_transactions(&setup.transport, 3);
        let engine = RunningEngine::start(setup);

        tokio::time::sleep(Duration::from_secs(590)).await;
        let open = engine.store.wallets().list().await.unwrap()[0].cursor;
        let cursor = engine.wait_for_complete_history(WALLET).await;

        assert_eq!(open, WalletCursor::NotStarted);
        assert!(
            matches!(cursor, WalletCursor::HistoryComplete { top: Some(top) }
            if top.signature == numbered_signature(0))
        );
        let counts = engine
            .wait_for_counts(WALLET, |counts| counts.fetched == 3)
            .await;
        assert_eq!(counts.listed, 3);
        engine.stop().await;
    }

    #[tokio::test(start_paused = true)]
    async fn defers_the_history_listing_to_the_next_day_once_catching_up_borrowed_its_share() {
        let setup = temporary_engine().await;
        // 95,000 credits a day: catching up may borrow up to 142,500.
        record_spent_today(&setup.store, Credits(142_500)).await;
        setup.store.wallets().add(WALLET, TEST_START).await.unwrap();
        let engine = RunningEngine::start(setup);

        let before_midnight = Duration::from_mins(9 * 60 + 46);
        tokio::time::sleep(before_midnight).await;
        let calls_before_midnight = engine.transport.calls().len();
        for _listing_and_its_confirmation in 0..2 {
            let listing = engine.transport.expect("getSignaturesForAddress");
            listing.respond(signature_page(0, 1));
        }
        expect_transactions(&engine.transport, 1);
        engine.wait_for_complete_history(WALLET).await;

        assert_eq!(calls_before_midnight, 0);
        engine.stop().await;
    }
}
