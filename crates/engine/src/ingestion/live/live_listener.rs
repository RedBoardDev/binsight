//! The listener: turns what the stream reports into work.
//!
//! A signature the stream saw is recorded for its wallet and its fetch queued as live work, due
//! when the transaction should be final (it is fetched at `finalized`: a few seconds after it is
//! confirmed); the fetcher is woken. Everything the stream reports also updates the
//! [`LiveState`], which wakes the listing worker: a subscription asks for a top-up, activity for
//! a check, a disconnection for frequent checks. A signature that cannot be recorded is not lost:
//! the check that follows the activity lists it.

use binsight_chain::{Activity, StreamEvent};
use binsight_store::DetectedSignature;
use jiff::{SignedDuration, Timestamp};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use tracing::{debug, error};

use crate::ingestion::Ingestion;

/// How long after its confirmation a transaction is final, and can be fetched at `finalized`:
/// 32 slots of 400 ms, and a little more.
const FINALIZATION_WAIT: SignedDuration = SignedDuration::from_secs(13);

/// Handles the stream's events until `shutdown` is cancelled or the stream stops.
pub(in crate::ingestion) async fn run_live_listener(
    ingestion: &Ingestion,
    mut events: mpsc::Receiver<StreamEvent>,
    shutdown: &CancellationToken,
) {
    loop {
        let event = tokio::select! {
            () = shutdown.cancelled() => return,
            event = events.recv() => event,
        };
        let Some(event) = event else {
            return;
        };
        let now = ingestion.clock.now();
        if let StreamEvent::Activity(activity) = &event {
            record(ingestion, activity, now).await;
        }
        ingestion.live.apply(&event, now);
    }
}

/// Records a signature the stream saw and queues its fetch.
async fn record(ingestion: &Ingestion, activity: &Activity, now: Timestamp) {
    let detected = DetectedSignature {
        wallet: activity.wallet,
        signature: activity.signature,
        slot: activity.slot,
        is_failed: activity.is_failed,
        detected_at: now,
        fetch_at: now.checked_add(FINALIZATION_WAIT).unwrap_or(now),
    };
    match ingestion.store.signatures().record_detected(detected).await {
        Ok(is_new) => {
            debug!(wallet = %activity.wallet, signature = %activity.signature, is_new, "live activity");
            ingestion.new_tasks.notify_one();
        }
        Err(error) => {
            error!(wallet = %activity.wallet, signature = %activity.signature, %error,
                "could not record a signature the stream saw; the next check lists it");
        }
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use binsight_solana::Address;
    use binsight_store::WalletCursor;
    use serde_json::json;
    use tokio::time::Instant;

    use crate::test_support::{
        RunningEngine, complete_history, expect_nothing_new, expect_transactions,
        numbered_signature, signature_page, transaction_reply,
    };

    const WALLET: Address = Address::from_bytes([1; 32]);
    const OTHER: Address = Address::from_bytes([2; 32]);

    /// The slot of the transaction numbered `number` in `signature_page`.
    fn slot_of(number: u16) -> u64 {
        100_000 - u64::from(number)
    }

    /// The parameters of a check of `wallet` above the signature numbered `top`.
    fn check_params(wallet: Address, top: u16) -> serde_json::Value {
        json!([
            wallet.to_string(),
            {"limit": 1_000, "commitment": "finalized",
             "until": numbered_signature(top).to_string()}
        ])
    }

    #[tokio::test(start_paused = true)]
    async fn fetches_a_streamed_transaction_once_it_is_final_then_lists_it_once() {
        let setup = complete_history(&[WALLET], 2_000).await;
        expect_nothing_new(&setup.transport, WALLET, 2_000);
        setup
            .transport
            .expect("getTransaction")
            .respond(transaction_reply());
        setup
            .transport
            .expect("getSignaturesForAddress")
            .with_params(check_params(WALLET, 2_000))
            .respond(signature_page(5, 1));
        let engine = RunningEngine::start(setup);
        engine.wait_for_calls(1).await;

        engine
            .stream
            .notify(WALLET, numbered_signature(5), slot_of(5), false);
        let notified = Instant::now();
        engine
            .wait_for_counts(WALLET, |counts| counts.fetched == 2)
            .await;
        let latency = notified.elapsed();
        tokio::time::sleep(Duration::from_secs(60)).await;

        assert!(latency >= Duration::from_secs(13) && latency <= Duration::from_secs(15));
        assert_eq!(engine.transport.calls().len(), 3);
        let cursor = engine.store.wallets().list().await.unwrap()[0].cursor;
        assert!(
            matches!(cursor, WalletCursor::HistoryComplete { top: Some(top) }
            if top.signature == numbered_signature(5))
        );
        let listed = engine
            .store
            .signatures()
            .get(WALLET, numbered_signature(5))
            .await;
        assert_eq!(listed.unwrap().unwrap().slot_order, Some(0));
        engine.stop().await;
    }

    #[tokio::test(start_paused = true)]
    async fn checks_a_bursting_wallet_with_one_listing() {
        let setup = complete_history(&[WALLET], 2_000).await;
        expect_nothing_new(&setup.transport, WALLET, 2_000);
        expect_transactions(&setup.transport, 5);
        setup
            .transport
            .expect("getSignaturesForAddress")
            .with_params(check_params(WALLET, 2_000))
            .respond(signature_page(1, 5));
        let engine = RunningEngine::start(setup);
        engine.wait_for_calls(1).await;

        for number in (1..=5).rev() {
            engine
                .stream
                .notify(WALLET, numbered_signature(number), slot_of(number), false);
            tokio::time::sleep(Duration::from_secs(2)).await;
        }
        tokio::time::sleep(Duration::from_secs(120)).await;

        let listings = engine
            .transport
            .calls()
            .iter()
            .filter(|call| call.method == "getSignaturesForAddress")
            .count();
        assert_eq!(listings, 2);
        let counts = engine.store.fetch_queue().counts(WALLET).await.unwrap();
        assert_eq!((counts.listed, counts.fetched), (6, 6));
        engine.stop().await;
    }

    #[tokio::test(start_paused = true)]
    async fn fetches_a_streamed_signature_once_for_two_tracked_wallets() {
        let setup = complete_history(&[WALLET, OTHER], 2_000).await;
        for wallet in [WALLET, OTHER] {
            expect_nothing_new(&setup.transport, wallet, 2_000);
            setup
                .transport
                .expect("getSignaturesForAddress")
                .with_params(check_params(wallet, 2_000))
                .respond(signature_page(5, 1));
        }
        expect_transactions(&setup.transport, 1);
        let engine = RunningEngine::start(setup);
        engine.wait_for_calls(2).await;

        for wallet in [WALLET, OTHER] {
            engine
                .stream
                .notify(wallet, numbered_signature(5), slot_of(5), false);
        }
        tokio::time::sleep(Duration::from_secs(60)).await;

        let fetches = engine
            .transport
            .calls()
            .iter()
            .filter(|call| call.method == "getTransaction")
            .count();
        assert_eq!(fetches, 1);
        for wallet in [WALLET, OTHER] {
            let counts = engine.store.fetch_queue().counts(wallet).await.unwrap();
            assert_eq!(counts.fetched, 2);
        }
        engine.stop().await;
    }

    #[tokio::test(start_paused = true)]
    async fn loses_no_signature_across_a_reconnect() {
        let setup = complete_history(&[WALLET], 2_000).await;
        expect_nothing_new(&setup.transport, WALLET, 2_000);
        setup
            .transport
            .expect("getSignaturesForAddress")
            .with_params(check_params(WALLET, 2_000))
            .respond(signature_page(7, 1));
        expect_transactions(&setup.transport, 1);
        let engine = RunningEngine::start(setup);
        engine.wait_for_calls(1).await;

        engine.stream.drop_connection();
        let counts = engine
            .wait_for_counts(WALLET, |counts| counts.fetched == 2)
            .await;

        assert_eq!(counts.listed, 2);
        assert_eq!(engine.stream.connections_opened(), 2);
        let cursor = engine.store.wallets().list().await.unwrap()[0].cursor;
        assert!(
            matches!(cursor, WalletCursor::HistoryComplete { top: Some(top) }
            if top.signature == numbered_signature(7))
        );
        engine.stop().await;
    }

    #[tokio::test(start_paused = true)]
    async fn checks_every_minute_while_the_stream_cannot_subscribe() {
        let setup = complete_history(&[WALLET], 2_000).await;
        setup.stream.refuse_subscriptions(-32_600, "not available");
        for _startup_and_three_minutes in 0..4 {
            expect_nothing_new(&setup.transport, WALLET, 2_000);
        }
        let engine = RunningEngine::start(setup);

        tokio::time::sleep(Duration::from_secs(200)).await;

        assert_eq!(engine.transport.calls().len(), 4);
        engine.stop().await;
    }

    #[tokio::test(start_paused = true)]
    async fn keeps_checking_on_its_cadence_while_the_stream_is_healthy() {
        let setup = complete_history(&[WALLET], 2_000).await;
        for _startup_and_two_cadences in 0..3 {
            expect_nothing_new(&setup.transport, WALLET, 2_000);
        }
        let engine = RunningEngine::start(setup);

        tokio::time::sleep(Duration::from_secs(1_850)).await;

        assert_eq!(engine.transport.calls().len(), 3);
        engine.stop().await;
    }
}
