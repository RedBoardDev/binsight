//! The listing worker: lists what each tracked wallet did, from its first transaction to its
//! newest, and keeps listing its newest ones.
//!
//! One worker does every listing, so a wallet's cursor has a single writer. Each step runs the
//! most urgent listing due (`listing_step`): a check or a top-up from the newest signature
//! (`top_up`), else the next page of a history (`history_page`), else the next page of a repair,
//! which lists a complete history again down to the last verified point and fills the gaps it
//! finds (`repair_pass`, on the `repair_schedule`). Between steps it sleeps until the next
//! listing falls due, or until the live stream changes something.

mod history_cursor;
mod history_end;
mod history_page;
mod history_schedule;
mod listing_step;
mod page_listing;
mod repair_pass;
mod repair_rules;
mod repair_schedule;
mod repairs;
mod top_up;
mod top_up_rules;

use tokio_util::sync::CancellationToken;

pub use repair_rules::{RepairEstimate, estimate_full_repair};

use super::Ingestion;
use listing_step::{ListingWorker, Progress};

/// Lists until `shutdown` is cancelled.
pub(super) async fn run_listing(ingestion: &Ingestion, shutdown: &CancellationToken) {
    let mut worker = ListingWorker::default();
    loop {
        let progress = tokio::select! {
            () = shutdown.cancelled() => return,
            progress = worker.step(ingestion) => progress,
        };
        let Progress::Wait(delay) = progress else {
            continue;
        };
        let timer = async {
            match delay {
                Some(delay) => tokio::time::sleep(delay).await,
                None => std::future::pending().await,
            }
        };
        tokio::select! {
            () = shutdown.cancelled() => return,
            () = ingestion.live.changed() => {}
            () = timer => {}
        }
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

    use binsight_core::credits::Credits;

    use crate::test_support::{
        RunningEngine, TEST_START, expect_nothing_new, expect_transactions, numbered_signature,
        record_spent_today, signature_page, temporary_engine,
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
        let cadence_check = 1;
        expect_nothing_new(&setup.transport, WALLET, 0);
        let engine = RunningEngine::start(setup);

        engine.wait_for_complete_history(WALLET).await;
        engine
            .wait_for_counts(WALLET, |counts| counts.fetched == 2)
            .await;
        tokio::time::sleep(Duration::from_secs(1_000)).await;
        assert_eq!(engine.transport.calls().len(), 2 + 2 + cadence_check + 6);

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
        // The wallet was added almost ten hours ago: its first repair is due once its history
        // is listed.
        for _listing_its_confirmation_and_the_repair in 0..3 {
            let listing = engine.transport.expect("getSignaturesForAddress");
            listing.respond(signature_page(0, 1));
        }
        expect_transactions(&engine.transport, 1);
        engine.wait_for_complete_history(WALLET).await;

        assert_eq!(calls_before_midnight, 0);
        engine.stop().await;
    }
}
