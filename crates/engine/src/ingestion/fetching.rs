//! The fetch worker: fetches every due transaction of the queue, a few at a time.
//!
//! It takes the tasks due now from the database (the most urgent class first, then the newest
//! slots) and hands them to `fetch_batch`. When nothing is due it sleeps until the next task
//! falls due, or until the listing queues new ones. A refusal that concerns every request pauses
//! it, and so does a database failure; new tasks do not cut a pause short.

mod fetch_batch;
mod fetch_outcome;

use std::time::Duration;

use binsight_core::credits::Priority;
use jiff::Timestamp;
use tokio_util::sync::CancellationToken;
use tracing::error;

use super::Ingestion;
use super::refusal::time_until;
use fetch_batch::{Fetched, fetch_all};

/// How many due tasks are read from the queue at once.
const FETCH_BATCH_SIZE: u32 = 32;

/// The longest the worker sleeps without looking at the queue again.
const IDLE_RECHECK: Duration = Duration::from_secs(60);

/// How long to wait after the queue could not be read.
const STORE_RETRY_DELAY: Duration = Duration::from_secs(30);

/// Fetches due tasks until `shutdown` is cancelled.
pub(super) async fn run_fetcher(ingestion: &Ingestion, shutdown: &CancellationToken) {
    loop {
        match fetch_due_tasks(ingestion, shutdown).await {
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

/// Fetches one batch of due tasks, and says when to look at the queue again.
async fn fetch_due_tasks(ingestion: &Ingestion, shutdown: &CancellationToken) -> Next {
    let now = ingestion.clock.now();
    let tasks = match ingestion
        .store
        .fetch_queue()
        .due(now, FETCH_BATCH_SIZE, Priority::Valuation)
        .await
    {
        Ok(tasks) => tasks,
        Err(error) => {
            error!(%error, "could not read the fetch queue");
            return Next::Pause(STORE_RETRY_DELAY);
        }
    };
    if tasks.is_empty() {
        return Next::Idle(idle_wait(ingestion, now).await);
    }
    match fetch_all(ingestion, tasks, shutdown).await {
        Fetched::Recorded => Next::Now,
        Fetched::NotRecorded => Next::Pause(STORE_RETRY_DELAY),
        Fetched::PausedUntil(until) => Next::Pause(time_until(ingestion.clock.now(), until)),
        Fetched::Stopped => Next::Stop,
    }
}

/// How long to sleep when nothing is due: until the next task falls due, at most a minute.
async fn idle_wait(ingestion: &Ingestion, now: Timestamp) -> Duration {
    match ingestion
        .store
        .fetch_queue()
        .next_attempt_at(Priority::Valuation)
        .await
    {
        Ok(Some(next)) => time_until(now, next).min(IDLE_RECHECK),
        Ok(None) => IDLE_RECHECK,
        Err(error) => {
            error!(%error, "could not read when the next fetch is due");
            STORE_RETRY_DELAY
        }
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use binsight_chain::test_support::ScriptedReply;
    use binsight_solana::Address;
    use serde_json::json;

    use crate::test_support::{
        RunningEngine, TEST_START, numbered_signature, signature_page, temporary_engine,
        transaction_reply,
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

    fn fetch_calls(engine: &RunningEngine) -> usize {
        let calls = engine.transport.calls();
        calls
            .iter()
            .filter(|call| call.method == "getTransaction")
            .count()
    }
}
