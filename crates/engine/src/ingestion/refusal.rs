//! Refusals that concern more than the request that met them, and how long work waits.
//!
//! Two kinds exist. The budget may defer a class of requests (its share of the day is spent, its
//! lane is full, or the cycle's last credits are kept for live work): that class and the less
//! urgent ones wait, the more urgent ones go on, and nothing is dropped. Other refusals stop
//! every request: the daily limit, the cycle's credits spent, a refused key or a method outside
//! the plan. Retrying either, or charging the attempt to a transaction, would only waste time.
//! Every worker reads the same rules here, and keeps its deferrals in a [`ClassDeferrals`].

use std::collections::BTreeMap;
use std::time::Duration;

use binsight_chain::{BudgetRefusal, RpcError};
use binsight_core::credits::Priority;
use jiff::{SignedDuration, Timestamp};
use tracing::{error, warn};

use super::Ingestion;

/// How long work waits after the provider refused the key, the plan or the credits.
const PROVIDER_REFUSAL_PAUSE_SECS: i64 = 600;

/// What a refusal means for the work that met it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Refusal {
    /// The request's class, and the less urgent ones, wait until then.
    Deferred(Timestamp),
    /// Every request waits until then.
    Paused(Timestamp),
}

/// What `error` means for the work that met it, or `None` if it only concerns this request.
pub(super) fn refusal_of(error: &RpcError, now: Timestamp) -> Option<Refusal> {
    match error {
        RpcError::Budget(
            refusal @ (BudgetRefusal::Deferred { .. } | BudgetRefusal::CycleReserveReached { .. }),
        ) => Some(Refusal::Deferred(refusal.resume_at())),
        RpcError::Budget(
            refusal @ (BudgetRefusal::DailyHardLimitReached { .. }
            | BudgetRefusal::CycleQuotaSpent { .. }),
        ) => Some(Refusal::Paused(refusal.resume_at())),
        RpcError::Unauthorized
        | RpcError::CreditsExhausted
        | RpcError::NotAvailableOnPlan { .. } => Some(Refusal::Paused(
            now.checked_add(SignedDuration::from_secs(PROVIDER_REFUSAL_PAUSE_SECS))
                .unwrap_or(Timestamp::MAX),
        )),
        _ => None,
    }
}

/// Logs a pause: a warning for a budget limit, which lifts by itself; an error otherwise, which
/// the sync state reports until the pause ends. Either way the sync states are decided again,
/// since a pause changes what keeps the wallets behind.
pub(super) fn report_pause(
    ingestion: &Ingestion,
    worker: &'static str,
    reason: &RpcError,
    until: Timestamp,
) {
    if matches!(reason, RpcError::Budget(_)) {
        warn!(worker, %reason, %until, "rpc work paused");
        ingestion.sync_changed.notify_one();
    } else {
        error!(worker, %reason, %until, "the rpc provider refuses requests; rpc work paused");
        ingestion.provider_refused(until);
    }
}

/// How long from `now` until `instant`; nothing if it has passed.
pub(super) fn time_until(now: Timestamp, instant: Timestamp) -> Duration {
    Duration::try_from(instant.duration_since(now)).unwrap_or(Duration::ZERO)
}

/// The classes of requests a worker holds back, and until when.
#[derive(Debug, Default)]
pub(super) struct ClassDeferrals {
    until: BTreeMap<Priority, Timestamp>,
}

impl ClassDeferrals {
    /// Holds back `class` and every less urgent one until `until`.
    pub(super) fn defer(&mut self, class: Priority, until: Timestamp) {
        let held = self.until.entry(class).or_insert(until);
        *held = (*held).max(until);
    }

    /// The least urgent class that may go at `now`, or `None` if even live requests wait.
    pub(super) fn least_urgent_allowed(&self, now: Timestamp) -> Option<Priority> {
        let mut allowed = None;
        for class in Priority::ALL {
            if self.until.get(&class).is_some_and(|until| *until > now) {
                return allowed;
            }
            allowed = Some(class);
        }
        allowed
    }

    /// When the next deferral after `now` ends, if one does.
    pub(super) fn next_end(&self, now: Timestamp) -> Option<Timestamp> {
        self.until
            .values()
            .filter(|until| **until > now)
            .min()
            .copied()
    }
}

#[cfg(test)]
mod tests {
    use binsight_chain::TransportError;
    use binsight_core::credits::Credits;

    use super::*;

    fn now() -> Timestamp {
        Timestamp::from_second(1_790_000_000).unwrap()
    }

    fn later(secs: i64) -> Timestamp {
        now().checked_add(SignedDuration::from_secs(secs)).unwrap()
    }

    #[tokio::test]
    async fn decides_the_sync_states_again_when_the_credit_limit_pauses_work() {
        let setup = crate::test_support::temporary_engine().await;
        let ingestion = Ingestion::on_test_engine(&setup);
        let limit = RpcError::Budget(BudgetRefusal::DailyHardLimitReached {
            limit: Credits(5_000),
            resets_at: later(3_600),
        });

        report_pause(&ingestion, "fetch", &limit, later(3_600));

        let woken = tokio::time::timeout(Duration::from_secs(1), ingestion.sync_changed.notified());
        assert!(woken.await.is_ok());
    }

    #[test]
    fn waits_for_the_next_day_once_the_daily_limit_is_reached() {
        let resets_at = Timestamp::from_second(1_790_035_200).unwrap();
        let refusal = RpcError::Budget(BudgetRefusal::DailyHardLimitReached {
            limit: Credits(5_000),
            resets_at,
        });

        assert_eq!(
            refusal_of(&refusal, now()),
            Some(Refusal::Paused(resets_at))
        );
    }

    #[test]
    fn waits_ten_minutes_when_the_provider_refuses_the_key() {
        let refusal = refusal_of(&RpcError::Unauthorized, now());
        assert_eq!(refusal, Some(Refusal::Paused(later(600))));
    }

    #[test]
    fn defers_only_the_class_when_the_budget_says_so() {
        let deferred = RpcError::Budget(BudgetRefusal::Deferred { until: later(5) });
        let reserved = RpcError::Budget(BudgetRefusal::CycleReserveReached {
            resets_at: later(90),
        });

        assert_eq!(
            refusal_of(&deferred, now()),
            Some(Refusal::Deferred(later(5)))
        );
        assert_eq!(
            refusal_of(&reserved, now()),
            Some(Refusal::Deferred(later(90)))
        );
    }

    #[test]
    fn leaves_an_error_of_one_request_to_its_own_retries() {
        let error = RpcError::Transport(TransportError::Request {
            detail: String::new(),
        });
        assert_eq!(refusal_of(&error, now()), None);
        assert_eq!(refusal_of(&RpcError::Timeout, now()), None);
    }

    #[test]
    fn waits_nothing_for_an_instant_already_past() {
        let earlier = Timestamp::from_second(1_789_000_000).unwrap();
        assert_eq!(time_until(now(), earlier), Duration::ZERO);
    }

    #[test]
    fn holds_back_a_class_and_the_less_urgent_ones_until_the_deferral_ends() {
        let mut deferrals = ClassDeferrals::default();
        assert_eq!(
            deferrals.least_urgent_allowed(now()),
            Some(Priority::Valuation)
        );

        deferrals.defer(Priority::CatchUp, later(30));

        assert_eq!(
            deferrals.least_urgent_allowed(now()),
            Some(Priority::Realtime)
        );
        assert_eq!(deferrals.next_end(now()), Some(later(30)));
        assert_eq!(
            deferrals.least_urgent_allowed(later(30)),
            Some(Priority::Valuation)
        );
        assert_eq!(deferrals.next_end(later(30)), None);
    }

    #[test]
    fn holds_back_everything_when_live_requests_are_deferred() {
        let mut deferrals = ClassDeferrals::default();

        deferrals.defer(Priority::Realtime, later(2));

        assert_eq!(deferrals.least_urgent_allowed(now()), None);
    }
}
