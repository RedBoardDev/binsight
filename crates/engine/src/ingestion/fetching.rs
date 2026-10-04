//! The fetch worker: fetches every due transaction of the queue, a few at a time.
//!
//! It takes the tasks due now from the database (the most urgent class first, then the newest
//! slots) and hands them to `fetch_batch`. When nothing is due it sleeps until the next task
//! falls due, or until the listing queues new ones. A class the credit budget defers is left out
//! of the queue until its deferral ends, while the more urgent classes go on: the tasks stay as
//! they are, so a deferral costs neither an attempt nor a write. A refusal that concerns every
//! request pauses the worker, and so does a database failure; new tasks do not cut a pause short.

mod fetch_batch;
mod fetch_outcome;

use std::time::Duration;

use binsight_core::credits::Priority;
use jiff::Timestamp;
use tokio_util::sync::CancellationToken;
use tracing::error;

use super::Ingestion;
use super::refusal::{ClassDeferrals, time_until};
use fetch_batch::{Fetched, fetch_all};

/// How many due tasks are read from the queue at once.
const FETCH_BATCH_SIZE: u32 = 32;

/// The longest the worker sleeps without looking at the queue again.
const IDLE_RECHECK: Duration = Duration::from_secs(60);

/// How long to wait after the queue could not be read.
const STORE_RETRY_DELAY: Duration = Duration::from_secs(30);

/// Fetches due tasks until `shutdown` is cancelled.
pub(super) async fn run_fetcher(ingestion: &Ingestion, shutdown: &CancellationToken) {
    let mut deferrals = ClassDeferrals::default();
    loop {
        match fetch_due_tasks(ingestion, &mut deferrals, shutdown).await {
            Next::Stop => return,
            Next::Now => {}
            Next::Idle(wait) => {
                tokio::select! {
                    () = shutdown.cancelled() => return,
                    () = ingestion.new_tasks.notified() => {}
                    () = tokio::time::sleep(wait) => {}
                }
            }
            Next::Pause(pause) => {
                tokio::select! {
                    () = shutdown.cancelled() => return,
                    () = tokio::time::sleep(pause) => {}
                }
            }
        }
    }
}

/// What the worker does after a batch.
enum Next {
    /// Look at the queue again at once.
    Now,
    /// Nothing is due: look at the queue again after this delay, or when new tasks arrive.
    Idle(Duration),
    /// Look at the queue again after this delay, whatever arrives meanwhile.
    Pause(Duration),
    /// Shutdown was requested.
    Stop,
}

/// Fetches one batch of the due tasks `deferrals` allows, and says when to look at the queue
/// again.
async fn fetch_due_tasks(
    ingestion: &Ingestion,
    deferrals: &mut ClassDeferrals,
    shutdown: &CancellationToken,
) -> Next {
    let now = ingestion.clock.now();
    let Some(least_urgent) = deferrals.least_urgent_allowed(now) else {
        return Next::Idle(idle_wait(ingestion, deferrals, None, now).await);
    };
    let queue = ingestion.store.fetch_queue();
    let tasks = match queue.due(now, FETCH_BATCH_SIZE, least_urgent).await {
        Ok(tasks) => tasks,
        Err(error) => {
            error!(%error, "could not read the fetch queue");
            return Next::Pause(STORE_RETRY_DELAY);
        }
    };
    if tasks.is_empty() {
        return Next::Idle(idle_wait(ingestion, deferrals, Some(least_urgent), now).await);
    }
    match fetch_all(ingestion, tasks, shutdown).await {
        Fetched::Recorded => Next::Now,
        Fetched::NotRecorded => Next::Pause(STORE_RETRY_DELAY),
        Fetched::Deferred { class, until } => {
            deferrals.defer(class, until);
            Next::Now
        }
        Fetched::PausedUntil(until) => Next::Pause(time_until(ingestion.clock.now(), until)),
        Fetched::Stopped => Next::Stop,
    }
}

/// How long to sleep when nothing allowed is due: until the next allowed task falls due or a
/// deferral ends, at most a minute.
async fn idle_wait(
    ingestion: &Ingestion,
    deferrals: &ClassDeferrals,
    least_urgent: Option<Priority>,
    now: Timestamp,
) -> Duration {
    let next_task = match least_urgent {
        None => Ok(None),
        Some(least_urgent) => {
            let queue = ingestion.store.fetch_queue();
            queue.next_attempt_at(least_urgent).await
        }
    };
    let next_task = match next_task {
        Ok(next_task) => next_task,
        Err(error) => {
            error!(%error, "could not read when the next fetch is due");
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

        // One credit every 86,400 s / 80,750 credits; the two listings count too.
        let one_credit_of_pace = Duration::from_millis(86_400_000 / 80_750);
        let elapsed = started.elapsed();
        assert!(elapsed >= one_credit_of_pace * 21, "{elapsed:?}");
        assert!(elapsed <= one_credit_of_pace * 26, "{elapsed:?}");
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
