//! Fetching one batch of due transactions, a few at a time, and recording each outcome.
//!
//! Up to [`FETCH_CONCURRENCY`] transactions are fetched at once; each one is stored or set back
//! as `fetch_outcome` decides. The batch as a whole ends with the outcome that should drive the
//! worker: a pause, a class the budget defers, a write failure, or success. Tasks come the most
//! urgent class first, so once a class is deferred or every request paused, no new fetch starts. At shutdown the batch
//! abandons its fetches and waits until they are gone, so each request in flight is counted by
//! the credit meter before the last flush.

use binsight_chain::CallContext;
use binsight_core::credits::{Priority, Purpose};
use binsight_store::{FetchSetback, FetchTask};
use jiff::Timestamp;
use tokio::task::JoinSet;
use tokio_util::sync::CancellationToken;
use tracing::{debug, error, warn};

use super::fetch_outcome::{FetchStep, next_step};
use crate::ingestion::Ingestion;
use crate::ingestion::refusal::report_pause;

/// How many transactions are fetched at the same time; the rate limiter paces them anyway.
const FETCH_CONCURRENCY: usize = 4;

/// How one fetch ended for the worker.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Fetched {
    /// The task was stored or rescheduled.
    Recorded,
    /// The outcome could not be written: the task is still due, so the worker must slow down
    /// rather than fetch it again at once.
    NotRecorded,
    /// The budget holds this class, and the less urgent ones, back until this instant.
    Deferred {
        /// The class.
        class: Priority,
        /// Until when.
        until: Timestamp,
    },
    /// The provider refuses every request until this instant.
    PausedUntil(Timestamp),
    /// Shutdown was requested; the fetches in flight were abandoned.
    Stopped,
}

/// Fetches `tasks`, a few at a time, and says how the batch ended as a whole: a pause wins over a
/// deferral, which wins over a write failure, which wins over success. No new fetch starts once
/// one asks to pause or defers its class.
pub(super) async fn fetch_all(
    ingestion: &Ingestion,
    tasks: Vec<FetchTask>,
    shutdown: &CancellationToken,
) -> Fetched {
    let mut waiting = tasks.into_iter();
    let mut running = JoinSet::new();
    let mut batch = Fetched::Recorded;
    loop {
        while running.len() < FETCH_CONCURRENCY
            && !matches!(batch, Fetched::PausedUntil(_) | Fetched::Deferred { .. })
        {
            let Some(task) = waiting.next() else {
                break;
            };
            running.spawn(fetch_one(ingestion.clone(), task));
        }
        let finished = tokio::select! {
            () = shutdown.cancelled() => {
                running.shutdown().await;
                return Fetched::Stopped;
            }
            finished = running.join_next() => finished,
        };
        let Some(finished) = finished else {
            return batch;
        };
        let fetched = finished.unwrap_or_else(|error| {
            error!(%error, "a fetch task stopped before finishing");
            Fetched::NotRecorded
        });
        batch = worst(batch, fetched);
    }
}

/// The outcome that should drive the worker: a stop, else the latest pause, else the deferral of
/// the most urgent class, else any write failure.
fn worst(batch: Fetched, fetched: Fetched) -> Fetched {
    match (batch, fetched) {
        (Fetched::Stopped, _) | (_, Fetched::Stopped) => Fetched::Stopped,
        (Fetched::PausedUntil(first), Fetched::PausedUntil(second)) => {
            Fetched::PausedUntil(first.max(second))
        }
        (Fetched::PausedUntil(until), _) | (_, Fetched::PausedUntil(until)) => {
            Fetched::PausedUntil(until)
        }
        (
            first @ Fetched::Deferred { class, .. },
            second @ Fetched::Deferred {
                class: other_class, ..
            },
        ) => {
            if class <= other_class {
                first
            } else {
                second
            }
        }
        (deferred @ Fetched::Deferred { .. }, _) | (_, deferred @ Fetched::Deferred { .. }) => {
            deferred
        }
        (Fetched::NotRecorded, _) | (_, Fetched::NotRecorded) => Fetched::NotRecorded,
        (Fetched::Recorded, Fetched::Recorded) => Fetched::Recorded,
    }
}

/// Fetches one transaction and records the outcome.
async fn fetch_one(ingestion: Ingestion, task: FetchTask) -> Fetched {
    let context = CallContext {
        priority: task.priority,
        purpose: Purpose::TransactionFetch,
        wallet: None,
    };
    let answer = ingestion.rpc.transaction(task.signature, context).await;
    let queue = ingestion.store.fetch_queue();
    match next_step(&task, answer, ingestion.clock.now()) {
        FetchStep::Store(fetched) => {
            let signature = fetched.signature;
            match queue.complete(fetched).await {
                Ok(()) => {
                    debug!(%signature, "transaction fetched");
                    Fetched::Recorded
                }
                Err(error) => {
                    error!(%signature, %error, "could not store a fetched transaction");
                    Fetched::NotRecorded
                }
            }
        }
        FetchStep::SetBack(failure) => {
            if let FetchSetback::RetryAt { state, at } = failure.setback {
                debug!(signature = %failure.signature, ?state, %at, "transaction not fetched yet");
            } else {
                warn!(signature = %failure.signature, "transaction version not supported; parked");
            }
            let signature = failure.signature;
            match queue.record_failure(failure).await {
                Ok(()) => Fetched::Recorded,
                Err(error) => {
                    error!(%signature, %error, "could not reschedule a transaction");
                    Fetched::NotRecorded
                }
            }
        }
        FetchStep::Defer { class, until } => {
            debug!(%class, %until, "fetching deferred by the credit budget");
            Fetched::Deferred { class, until }
        }
        FetchStep::Pause { until, reason } => {
            report_pause(&ingestion, "fetch", &reason, until);
            Fetched::PausedUntil(until)
        }
    }
}
