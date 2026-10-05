//! Fetches one transaction and records its result; the scheduler decides which one starts.
//!
//! Provider results either become an immutable raw transaction, a queued retry, or a typed
//! budget refusal. No class deferral consumes an attempt or modifies its stored task.

use binsight_chain::CallContext;
use binsight_core::credits::{Priority, Purpose};
use binsight_store::{FetchSetback, FetchTask};
use jiff::Timestamp;
use tracing::{debug, error, warn};

use super::fetch_outcome::{FetchStep, next_step};
use crate::ingestion::Ingestion;
use crate::ingestion::refusal::report_pause;

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
}

/// Fetches one transaction and records the outcome.
pub(super) async fn fetch_one(ingestion: Ingestion, task: FetchTask) -> Fetched {
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
                    ingestion.new_raw.notify_one();
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
