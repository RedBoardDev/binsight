//! What one `getTransaction` answer means for its fetch task, as a pure function.
//!
//! A transaction is stored as soon as the node returns it. A `null` answer is not "it does not
//! exist": a node may lag behind, so the task is tried again on a growing schedule and, once the
//! schedule runs out, rarely but forever; a signature is never dropped. A version the node cannot
//! return parks the task without blocking the others, noting the newest version binsight reads,
//! so a binsight that reads newer versions puts it back in the queue at startup. Refusals that no
//! retry can fix (the daily limit, a refused key, used-up credits) pause the whole fetcher
//! instead of burning the task's attempts. This module decides; the fetcher does the I/O.

use binsight_chain::{RawTransaction, RpcError, TransactionLookup};
use binsight_solana::transaction::MAX_SUPPORTED_TX_VERSION;
use binsight_store::{FetchFailure, FetchSetback, FetchTask, FetchedTx, RetryState};
use jiff::{SignedDuration, Timestamp};

use super::refusal::resume_after_refusal;

/// The waits before each new attempt, in seconds, after the first, second... failed attempt.
const RETRY_SCHEDULE_SECS: [i64; 8] = [1, 2, 4, 8, 30, 120, 600, 3_600];

/// How often a task whose schedule ran out is tried again.
const FAILED_RETRY_INTERVAL_SECS: i64 = 86_400;

/// What to do after one attempt to fetch a task.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum FetchStep {
    /// Store the transaction and mark the task fetched.
    Store(FetchedTx),
    /// Set the task back.
    SetBack(FetchFailure),
    /// Leave the task as it is and stop fetching until `until`.
    Pause {
        /// When fetching may resume.
        until: Timestamp,
        /// Why, for the log.
        reason: RpcError,
    },
}

/// The step after `task` was looked up with `answer` at `now`.
pub(super) fn next_step(
    task: &FetchTask,
    answer: Result<TransactionLookup, RpcError>,
    now: Timestamp,
) -> FetchStep {
    let attempts = task.attempts.saturating_add(1);
    match answer {
        Ok(TransactionLookup::Found(transaction)) => FetchStep::Store(fetched_tx(transaction, now)),
        Ok(TransactionLookup::NotFound) => {
            FetchStep::SetBack(retry(task, attempts, RetryState::EmptyRetry, None, now))
        }
        Err(RpcError::UnsupportedTransactionVersion) => FetchStep::SetBack(FetchFailure {
            signature: task.signature,
            setback: FetchSetback::UnsupportedVersion {
                max_supported_version: MAX_SUPPORTED_TX_VERSION,
            },
            attempts,
            error: Some(RpcError::UnsupportedTransactionVersion.to_string()),
            updated_at: now,
        }),
        Err(error) => match resume_after_refusal(&error, now) {
            Some(until) => FetchStep::Pause {
                until,
                reason: error,
            },
            None => FetchStep::SetBack(retry(
                task,
                attempts,
                RetryState::Pending,
                Some(error.to_string()),
                now,
            )),
        },
    }
}

/// A setback on the retry schedule; past its end, the task is `failed` and tried daily.
fn retry(
    task: &FetchTask,
    attempts: u32,
    state: RetryState,
    error: Option<String>,
    now: Timestamp,
) -> FetchFailure {
    let scheduled = usize::try_from(attempts.saturating_sub(1))
        .ok()
        .and_then(|index| RETRY_SCHEDULE_SECS.get(index));
    let (state, wait_secs) = match scheduled {
        Some(wait_secs) => (state, *wait_secs),
        None => (RetryState::Failed, FAILED_RETRY_INTERVAL_SECS),
    };
    FetchFailure {
        signature: task.signature,
        setback: FetchSetback::RetryAt {
            state,
            at: now
                .checked_add(SignedDuration::from_secs(wait_secs))
                .unwrap_or(Timestamp::MAX),
        },
        attempts,
        error,
        updated_at: now,
    }
}

fn fetched_tx(transaction: RawTransaction, now: Timestamp) -> FetchedTx {
    FetchedTx {
        signature: transaction.signature,
        slot: transaction.slot,
        block_time: transaction.block_time,
        tx_version: transaction.version,
        commitment: transaction.commitment,
        encoding: transaction.encoding,
        payload: transaction.result_json.into_bytes(),
        fetched_at: now,
    }
}

#[cfg(test)]
mod tests {
    use binsight_chain::{BudgetRefusal, TransportError};
    use binsight_core::credits::{Credits, Priority};
    use binsight_solana::Commitment;
    use binsight_solana::Signature;
    use binsight_solana::transaction::{TxEncoding, TxVersion};

    use super::*;

    fn now() -> Timestamp {
        Timestamp::from_second(1_790_000_000).unwrap()
    }

    fn task(attempts: u32) -> FetchTask {
        FetchTask {
            signature: Signature::from_bytes([1; 64]),
            slot: 50,
            priority: Priority::History,
            attempts,
        }
    }

    fn retry_at(step: &FetchStep) -> (RetryState, i64, u32) {
        let FetchStep::SetBack(FetchFailure {
            setback: FetchSetback::RetryAt { state, at },
            attempts,
            ..
        }) = step
        else {
            panic!("not a retry: {step:?}");
        };
        (*state, at.as_second() - now().as_second(), *attempts)
    }

    #[test]
    fn stores_a_found_transaction_as_the_node_wrote_it() {
        let transaction = RawTransaction {
            signature: Signature::from_bytes([1; 64]),
            slot: 50,
            block_time: None,
            version: TxVersion::V1,
            is_failed: false,
            encoding: TxEncoding::Base64,
            commitment: Commitment::Finalized,
            result_json: r#"{"slot":50}"#.to_owned(),
        };

        let step = next_step(&task(0), Ok(TransactionLookup::Found(transaction)), now());

        let FetchStep::Store(fetched) = step else {
            panic!("not stored: {step:?}");
        };
        assert_eq!(fetched.payload, br#"{"slot":50}"#);
        assert_eq!(fetched.tx_version, TxVersion::V1);
        assert_eq!(fetched.fetched_at, now());
    }

    #[test]
    fn tries_a_null_answer_again_on_a_growing_schedule() {
        let first = next_step(&task(0), Ok(TransactionLookup::NotFound), now());
        let fifth = next_step(&task(4), Ok(TransactionLookup::NotFound), now());

        assert_eq!(retry_at(&first), (RetryState::EmptyRetry, 1, 1));
        assert_eq!(retry_at(&fifth), (RetryState::EmptyRetry, 30, 5));
    }

    #[test]
    fn keeps_trying_daily_once_the_schedule_runs_out() {
        let step = next_step(&task(8), Ok(TransactionLookup::NotFound), now());
        assert_eq!(retry_at(&step), (RetryState::Failed, 86_400, 9));
    }

    #[test]
    fn parks_a_version_the_node_cannot_return() {
        let step = next_step(
            &task(0),
            Err(RpcError::UnsupportedTransactionVersion),
            now(),
        );

        let FetchStep::SetBack(failure) = step else {
            panic!("not parked: {step:?}");
        };
        assert_eq!(
            failure.setback,
            FetchSetback::UnsupportedVersion {
                max_supported_version: MAX_SUPPORTED_TX_VERSION
            }
        );
    }

    #[test]
    fn remembers_why_a_failed_attempt_failed() {
        let error = RpcError::Transport(TransportError::Connect {
            detail: "refused".to_owned(),
        });

        let step = next_step(&task(1), Err(error), now());

        assert_eq!(retry_at(&step), (RetryState::Pending, 2, 2));
        let FetchStep::SetBack(failure) = step else {
            panic!("not set back");
        };
        assert!(failure.error.unwrap().contains("refused"));
    }

    #[test]
    fn pauses_until_the_next_day_once_the_daily_limit_is_reached() {
        let resets_at = Timestamp::from_second(1_790_035_200).unwrap();
        let refusal = RpcError::Budget(BudgetRefusal::DailyHardLimitReached {
            limit: Credits(5_000),
            resets_at,
        });

        let step = next_step(&task(3), Err(refusal), now());

        assert!(matches!(step, FetchStep::Pause { until, .. } if until == resets_at));
    }

    #[test]
    fn pauses_without_spending_attempts_when_the_key_is_refused() {
        let step = next_step(&task(3), Err(RpcError::Unauthorized), now());

        let FetchStep::Pause { reason, .. } = step else {
            panic!("not paused: {step:?}");
        };
        assert_eq!(reason, RpcError::Unauthorized);
    }
}
