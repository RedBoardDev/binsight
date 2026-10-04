//! Refusals that concern every request, not the one that met them, and how long work waits.
//!
//! The daily credit limit, a refused key, used-up credits or a method outside the plan will refuse
//! the next request just the same: retrying, or charging the attempt to a transaction, would only
//! waste time. The worker that meets one pauses instead: until the next UTC day for the daily
//! limit, a while for the provider's refusals, which a human has to fix. Both workers read the
//! same rule here.

use std::time::Duration;

use binsight_chain::{BudgetRefusal, RpcError};
use jiff::{SignedDuration, Timestamp};
use tracing::{error, warn};

/// How long work waits after the provider refused the key, the plan or the credits.
const PROVIDER_REFUSAL_PAUSE_SECS: i64 = 600;

/// When work may resume after `error`, or `None` if the error only concerns this request.
pub(super) fn resume_after_refusal(error: &RpcError, now: Timestamp) -> Option<Timestamp> {
    match error {
        RpcError::Budget(BudgetRefusal::DailyHardLimitReached { resets_at, .. }) => {
            Some(*resets_at)
        }
        RpcError::Unauthorized
        | RpcError::CreditsExhausted
        | RpcError::NotAvailableOnPlan { .. } => Some(
            now.checked_add(SignedDuration::from_secs(PROVIDER_REFUSAL_PAUSE_SECS))
                .unwrap_or(Timestamp::MAX),
        ),
        _ => None,
    }
}

/// Logs a pause: a warning for the daily limit, which lifts by itself, an error otherwise.
pub(super) fn report_pause(worker: &'static str, reason: &RpcError, until: Timestamp) {
    if matches!(reason, RpcError::Budget(_)) {
        warn!(worker, %reason, %until, "rpc work paused");
    } else {
        error!(worker, %reason, %until, "the rpc provider refuses requests; rpc work paused");
    }
}

/// How long from `now` until `instant`; nothing if it has passed.
pub(super) fn time_until(now: Timestamp, instant: Timestamp) -> Duration {
    Duration::try_from(instant.duration_since(now)).unwrap_or(Duration::ZERO)
}

#[cfg(test)]
mod tests {
    use binsight_chain::TransportError;
    use binsight_core::credits::Credits;

    use super::*;

    fn now() -> Timestamp {
        Timestamp::from_second(1_790_000_000).unwrap()
    }

    #[test]
    fn waits_for_the_next_day_once_the_daily_limit_is_reached() {
        let resets_at = Timestamp::from_second(1_790_035_200).unwrap();
        let refusal = RpcError::Budget(BudgetRefusal::DailyHardLimitReached {
            limit: Credits(5_000),
            resets_at,
        });

        assert_eq!(resume_after_refusal(&refusal, now()), Some(resets_at));
    }

    #[test]
    fn waits_ten_minutes_when_the_provider_refuses_the_key() {
        let resume = resume_after_refusal(&RpcError::Unauthorized, now()).unwrap();
        assert_eq!(time_until(now(), resume), Duration::from_secs(600));
    }

    #[test]
    fn leaves_an_error_of_one_request_to_its_own_retries() {
        let error = RpcError::Transport(TransportError::Request {
            detail: String::new(),
        });
        assert_eq!(resume_after_refusal(&error, now()), None);
        assert_eq!(resume_after_refusal(&RpcError::Timeout, now()), None);
    }

    #[test]
    fn waits_nothing_for_an_instant_already_past() {
        let earlier = Timestamp::from_second(1_789_000_000).unwrap();
        assert_eq!(time_until(now(), earlier), Duration::ZERO);
    }
}
