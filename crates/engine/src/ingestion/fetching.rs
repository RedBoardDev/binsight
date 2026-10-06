//! Fetches due transactions continuously, reserving one of four slots for live work.
//!
//! The queue is reconsidered at every completion and notification. Three slow historical
//! requests cannot occupy the live slot; sent requests finish normally and are never replayed
//! to make room. Sleeps use queue deadlines and notifications, not polling.

mod fetch_attempt;
mod fetch_outcome;
mod fetch_schedule;

#[cfg(test)]
mod priority_tests;

use std::collections::BTreeMap;
use std::time::Duration;

use binsight_core::credits::Priority;
use binsight_solana::Signature;
use jiff::Timestamp;
use tokio::task::JoinSet;
use tokio_util::sync::CancellationToken;
use tracing::error;

use super::Ingestion;
use super::refusal::{ClassDeferrals, time_until};
use fetch_attempt::Fetched;
use fetch_schedule::fill_slots;

/// The longest idle wait without reconsidering the queue.
const IDLE_RECHECK: Duration = Duration::from_secs(60);
/// Wait after a store operation fails, before issuing another billable fetch.
const STORE_RETRY_DELAY: Duration = Duration::from_secs(30);

/// Fetches until shutdown, then waits for cancelled requests to record their spending.
pub(super) async fn run_fetcher(ingestion: &Ingestion, shutdown: &CancellationToken) {
    let mut running = JoinSet::new();
    let mut active = BTreeMap::<Signature, Priority>::new();
    let mut deferrals = ClassDeferrals::default();
    let mut pause_until: Option<Timestamp> = None;
    loop {
        let now = ingestion.clock.now();
        pause_until = pause_until.filter(|until| *until > now);
        let least_urgent = deferrals.least_urgent_allowed(now);
        let allowed = fetch_schedule::allowed_class(least_urgent, &active);
        if pause_until.is_none()
            && let Some(allowed) = allowed
            && let Err(error) = fill_slots(ingestion, allowed, &mut active, &mut running).await
        {
            error!(%error, "could not read the fetch queue");
            pause_until = after_store_failure(now);
        }
        let wait = if let Some(until) = pause_until {
            time_until(now, until)
        } else {
            let allowed = fetch_schedule::allowed_class(least_urgent, &active);
            idle_wait(ingestion, &deferrals, allowed, &active).await
        };
        tokio::select! {
            () = shutdown.cancelled() => { running.shutdown().await; return; }
            result = running.join_next(), if !running.is_empty() => {
                let Some(result) = result else { continue };
                let finished = match result {
                    Ok((signature, outcome)) => {
                        active.remove(&signature);
                        outcome
                    }
                    Err(error) => {
                        error!(%error, "a fetch task stopped before finishing");
                        running.shutdown().await;
                        active.clear();
                        Fetched::NotRecorded
                    }
                };
                match finished {
                    Fetched::Recorded => {}
                    Fetched::Deferred { class, until } => deferrals.defer(class, until),
                    Fetched::PausedUntil(until) => pause_until = Some(until),
                    Fetched::NotRecorded => {
                        pause_until = after_store_failure(ingestion.clock.now());
                    }
                }
            }
            () = ingestion.new_tasks.notified(), if pause_until.is_none() => {}
            () = tokio::time::sleep(wait) => {}
        }
    }
}

/// When fetching resumes after the database failed at `now`: no billable fetch is sent before.
fn after_store_failure(now: Timestamp) -> Option<Timestamp> {
    now.checked_add(STORE_RETRY_DELAY).ok()
}

async fn idle_wait(
    ingestion: &Ingestion,
    deferrals: &ClassDeferrals,
    least_urgent: Option<Priority>,
    active: &BTreeMap<Signature, Priority>,
) -> Duration {
    let now = ingestion.clock.now();
    let next_task = match least_urgent {
        None => Ok(None),
        Some(class) => {
            ingestion
                .store
                .fetch_queue()
                .next_attempt_excluding(class, active.keys().copied().collect())
                .await
        }
    };
    let next_task = match next_task {
        Ok(next) => next,
        Err(error) => {
            error!(%error, "could not read the next fetch deadline");
            return STORE_RETRY_DELAY;
        }
    };
    [next_task, deferrals.next_end(now)]
        .into_iter()
        .flatten()
        .min()
        .map_or(IDLE_RECHECK, |next| time_until(now, next).min(IDLE_RECHECK))
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use binsight_chain::test_support::ScriptedReply;
    use binsight_solana::Address;
    use serde_json::json;

    use binsight_core::credits::Credits;
    use tokio::time::Instant;

    use crate::test_support::{
        RunningEngine, TEST_START, expect_transactions, numbered_signature, record_spent_today,
        signature_page, temporary_engine, transaction_reply,
    };

    const WALLET: Address = Address::from_bytes([1; 32]);

    #[tokio::test(start_paused = true)]
    async fn does_not_skip_a_transaction_whose_first_fetch_returned_null() {
        let setup = temporary_engine().await;
        setup.store.wallets().add(WALLET, TEST_START).await.unwrap();
        let transport = &setup.transport;
        transport
            .expect("getSignaturesForAddress")
            .respond(signature_page(0, 1));
        transport
            .expect("getTransaction")
            .respond(ScriptedReply::Null);
        transport
            .expect("getTransaction")
            .respond(transaction_reply());
        let engine = RunningEngine::start(setup);

        let counts = engine
            .wait_for_counts(WALLET, |counts| counts.fetched == 1)
            .await;

        assert_eq!(counts.empty_retry, 0);
        assert_eq!(engine.transport.calls().len(), 3);
        engine.stop().await;
    }

    #[tokio::test(start_paused = true)]
    async fn parks_an_unsupported_version_without_blocking_the_others() {
        let setup = temporary_engine().await;
        setup.store.wallets().add(WALLET, TEST_START).await.unwrap();
        let transport = &setup.transport;
        transport
            .expect("getSignaturesForAddress")
            .respond(signature_page(0, 2));
        let options = json!({
            "encoding": "base64", "commitment": "finalized", "maxSupportedTransactionVersion": 1
        });
        transport
            .expect("getTransaction")
            .with_params(json!([numbered_signature(0).to_string(), options]))
            .respond(ScriptedReply::RpcError {
                code: -32015,
                message: "Transaction version (2) is not supported".to_owned(),
            });
        transport
            .expect("getTransaction")
            .respond(transaction_reply());
        let engine = RunningEngine::start(setup);

        let counts = engine
            .wait_for_counts(WALLET, |counts| {
                counts.fetched + counts.unsupported_version == 2
            })
            .await;

        assert_eq!((counts.fetched, counts.unsupported_version), (1, 1));
        engine.stop().await;
    }

    #[tokio::test(start_paused = true)]
    async fn stays_paused_after_a_refused_key_when_new_tasks_arrive() {
        let setup = temporary_engine().await;
        setup.store.wallets().add(WALLET, TEST_START).await.unwrap();
        let transport = &setup.transport;
        for _listing_and_its_confirmation in 0..2 {
            transport
                .expect("getSignaturesForAddress")
                .respond(signature_page(0, 1));
        }
        transport
            .expect("getTransaction")
            .respond(ScriptedReply::Http {
                status: 401,
                retry_after: None,
                body: "Unauthorized".to_owned(),
            });
        transport
            .expect("getTransaction")
            .respond(transaction_reply());
        let engine = RunningEngine::start(setup);

        engine.wait_for_complete_history(WALLET).await;
        tokio::time::sleep(Duration::from_secs(240)).await;
        let fetches_during_the_pause = fetch_calls(&engine);
        let counts = engine
            .wait_for_counts(WALLET, |counts| counts.fetched == 1)
            .await;

        assert_eq!(fetches_during_the_pause, 1);
        assert_eq!(counts.listed, 1);
        engine.stop().await;
    }

    #[tokio::test(start_paused = true)]
    async fn paces_the_history_import_on_the_day_share_of_the_credits_without_spending_attempts() {
        let setup = temporary_engine().await;
        // On 2026-09-21 at 14:13:20, the cycle has 10 days left: 95,000 credits a day, and
        // history may have spent 85 % of 15 h 13 min 20 s of them, 51,217 credits.
        record_spent_today(&setup.store, Credits(51_217)).await;
        setup.store.wallets().add(WALLET, TEST_START).await.unwrap();
        for _listing_and_its_confirmation in 0..2 {
            let listing = setup.transport.expect("getSignaturesForAddress");
            listing.respond(signature_page(0, 20));
        }
        expect_transactions(&setup.transport, 20);
        let engine = RunningEngine::start(setup);
        let started = Instant::now();

        engine
            .wait_for_counts(WALLET, |counts| counts.fetched == 20)
            .await;

        // One credit every 86,400 s / 80,750 credits; the two listings, the stream's opening and
        // its first data (3 credits) count too.
        let one_credit_of_pace = Duration::from_millis(86_400_000 / 80_750);
        let elapsed = started.elapsed();
        assert!(elapsed >= one_credit_of_pace * 24, "{elapsed:?}");
        assert!(elapsed <= one_credit_of_pace * 29, "{elapsed:?}");
        assert_eq!(fetch_calls(&engine), 20);
        engine.stop().await;
    }

    fn fetch_calls(engine: &RunningEngine) -> usize {
        let calls = engine.transport.calls();
        calls
            .iter()
            .filter(|call| call.method == "getTransaction")
            .count()
    }
}
