//! Counting the credits every request costs, and refusing requests past the daily hard limit.
//!
//! Every request sent is counted with its outcome, retries included, because the provider may
//! bill each one: the meter would rather overstate than understate. Counts are grouped per UTC
//! day, method, priority, purpose, wallet and outcome, kept in memory and handed over by
//! [`CreditMeter::drain`] for the engine to persist (the chain client does not know the
//! database), and given back by [`CreditMeter::restore`] when they could not be. The day's total is also kept, to enforce the optional hard daily limit before a
//! request leaves; [`CreditMeter::seed_spent_today`] restores it from the database at startup so
//! a restart does not reset the guard.

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use binsight_core::clock::{Clock, start_of_next_utc_day, utc_day};
use binsight_core::credits::{CallOutcome, Credits, Priority, Purpose};
use binsight_solana::Address;
use jiff::civil::Date;

use crate::error::BudgetRefusal;
use crate::rpc::{CallContext, RpcMethod};

/// The credits spent by a group of identical requests on one day.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CreditUsage {
    /// The UTC day the requests were sent.
    pub day: Date,
    /// The method called.
    pub method: RpcMethod,
    /// The class of the calls.
    pub priority: Priority,
    /// The work they belonged to.
    pub purpose: Purpose,
    /// The wallet they served, if any.
    pub wallet: Option<Address>,
    /// How they ended.
    pub outcome: CallOutcome,
    /// How many requests were sent.
    pub calls: u64,
    /// The credits they cost.
    pub credits: Credits,
}

/// Counts the credits spent and guards the daily hard limit.
pub struct CreditMeter {
    clock: Arc<dyn Clock>,
    daily_limit: Option<Credits>,
    state: Mutex<MeterState>,
}

struct MeterState {
    day: Date,
    spent_today: Credits,
    pending: BTreeMap<UsageKey, (u64, Credits)>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
struct UsageKey {
    day: Date,
    method: RpcMethod,
    priority: Priority,
    purpose: Purpose,
    wallet: Option<Address>,
    outcome: CallOutcome,
}

impl CreditMeter {
    /// A meter with nothing spent today, and a hard daily limit if `daily_limit` is set.
    pub(crate) fn new(clock: Arc<dyn Clock>, daily_limit: Option<Credits>) -> Self {
        let day = utc_day(clock.now());
        Self {
            clock,
            daily_limit,
            state: Mutex::new(MeterState {
                day,
                spent_today: Credits::ZERO,
                pending: BTreeMap::new(),
            }),
        }
    }

    /// Sets what was already spent today, as persisted before a restart.
    pub fn seed_spent_today(&self, spent: Credits) {
        let today = utc_day(self.clock.now());
        let mut state = self.lock();
        state.day = today;
        state.spent_today = spent;
    }

    /// The credits spent today (UTC), seed included.
    #[cfg(test)]
    pub(crate) fn spent_today(&self) -> Credits {
        let today = utc_day(self.clock.now());
        let state = self.lock();
        if state.day == today {
            state.spent_today
        } else {
            Credits::ZERO
        }
    }

    /// Takes every count gathered since the last drain.
    pub fn drain(&self) -> Vec<CreditUsage> {
        let pending = std::mem::take(&mut self.lock().pending);
        pending
            .into_iter()
            .map(|(key, (calls, credits))| CreditUsage {
                day: key.day,
                method: key.method,
                priority: key.priority,
                purpose: key.purpose,
                wallet: key.wallet,
                outcome: key.outcome,
                calls,
                credits,
            })
            .collect()
    }

    /// Gives back counts taken by [`CreditMeter::drain`] that could not be persisted, so the next
    /// drain hands them over again. Today's total is not touched: it already includes them.
    pub fn restore(&self, usages: Vec<CreditUsage>) {
        let mut state = self.lock();
        for usage in usages {
            let key = UsageKey {
                day: usage.day,
                method: usage.method,
                priority: usage.priority,
                purpose: usage.purpose,
                wallet: usage.wallet,
                outcome: usage.outcome,
            };
            let entry = state.pending.entry(key).or_insert((0, Credits::ZERO));
            entry.0 = entry.0.saturating_add(usage.calls);
            entry.1 = entry.1.saturating_add(usage.credits);
        }
    }

    /// Books `cost` against today's allowance before a request is sent.
    pub(crate) fn reserve(&self, cost: Credits) -> Result<(), BudgetRefusal> {
        let now = self.clock.now();
        let today = utc_day(now);
        let mut state = self.lock();
        if state.day != today {
            state.day = today;
            state.spent_today = Credits::ZERO;
        }
        let after = state.spent_today.saturating_add(cost);
        if let Some(limit) = self.daily_limit.filter(|limit| after > *limit) {
            return Err(BudgetRefusal::DailyHardLimitReached {
                limit,
                resets_at: start_of_next_utc_day(today),
            });
        }
        state.spent_today = after;
        Ok(())
    }

    /// Counts one request that was sent, with how it ended.
    pub(crate) fn record(
        &self,
        method: RpcMethod,
        context: &CallContext,
        outcome: CallOutcome,
        cost: Credits,
    ) {
        let key = UsageKey {
            day: utc_day(self.clock.now()),
            method,
            priority: context.priority,
            purpose: context.purpose,
            wallet: context.wallet,
            outcome,
        };
        let mut state = self.lock();
        let entry = state.pending.entry(key).or_insert((0, Credits::ZERO));
        entry.0 = entry.0.saturating_add(1);
        entry.1 = entry.1.saturating_add(cost);
    }

    fn lock(&self) -> MutexGuard<'_, MeterState> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

impl std::fmt::Debug for CreditMeter {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("CreditMeter")
            .field("daily_limit", &self.daily_limit)
            .finish_non_exhaustive()
    }
}

#[cfg(test)]
mod tests {
    use binsight_core::clock::FixedClock;
    use jiff::{SignedDuration, Timestamp};

    use super::*;

    /// 2026-09-21 at 14:13 UTC.
    const SEPTEMBER_21_AFTERNOON: i64 = 1_790_000_000;

    fn context() -> CallContext {
        CallContext {
            priority: Priority::History,
            purpose: Purpose::TransactionFetch,
            wallet: Some(Address::from_bytes([1; 32])),
        }
    }

    fn meter(limit: Option<u64>) -> (Arc<FixedClock>, CreditMeter) {
        let clock = Arc::new(FixedClock::new(
            Timestamp::from_second(SEPTEMBER_21_AFTERNOON).unwrap(),
        ));
        let meter = CreditMeter::new(clock.clone(), limit.map(Credits));
        (clock, meter)
    }

    #[test]
    fn refuses_every_call_once_the_daily_hard_limit_is_reached() {
        let (_clock, meter) = meter(Some(2));

        assert_eq!(meter.reserve(Credits(1)), Ok(()));
        assert_eq!(meter.reserve(Credits(1)), Ok(()));
        let refusal = meter.reserve(Credits(1)).unwrap_err();

        let BudgetRefusal::DailyHardLimitReached { limit, resets_at } = refusal;
        assert_eq!(limit, Credits(2));
        assert_eq!(resets_at.to_string(), "2026-09-22T00:00:00Z");
        assert_eq!(meter.spent_today(), Credits(2));
    }

    #[test]
    fn keeps_the_guard_across_a_restart_once_seeded() {
        let (_clock, meter) = meter(Some(5));

        meter.seed_spent_today(Credits(5));

        assert!(meter.reserve(Credits(1)).is_err());
    }

    #[test]
    fn starts_each_utc_day_with_nothing_spent() {
        let (clock, meter) = meter(Some(1));
        meter.reserve(Credits(1)).unwrap();
        assert!(meter.reserve(Credits(1)).is_err());

        clock.advance(SignedDuration::from_hours(13)).unwrap();

        assert_eq!(meter.spent_today(), Credits::ZERO);
        assert_eq!(meter.reserve(Credits(1)), Ok(()));
    }

    #[test]
    fn never_refuses_without_a_limit() {
        let (_clock, meter) = meter(None);
        meter.seed_spent_today(Credits(u64::MAX));

        assert_eq!(meter.reserve(Credits(1)), Ok(()));
    }

    #[test]
    fn groups_identical_requests_and_empties_on_drain() {
        let (_clock, meter) = meter(None);
        let method = RpcMethod::GetTransaction;
        meter.record(method, &context(), CallOutcome::Ok, Credits(1));
        meter.record(method, &context(), CallOutcome::Ok, Credits(1));
        meter.record(method, &context(), CallOutcome::Timeout, Credits(1));

        let drained = meter.drain();

        assert_eq!(drained.len(), 2);
        let ok = drained
            .iter()
            .find(|usage| usage.outcome == CallOutcome::Ok)
            .unwrap();
        assert_eq!((ok.calls, ok.credits), (2, Credits(2)));
        assert_eq!(ok.day.to_string(), "2026-09-21");
        assert_eq!(meter.drain(), Vec::new());
    }

    #[test]
    fn hands_restored_counts_over_again_with_the_new_ones() {
        let (_clock, meter) = meter(Some(10));
        let method = RpcMethod::GetTransaction;
        meter.record(method, &context(), CallOutcome::Ok, Credits(1));
        let unsaved = meter.drain();
        meter.record(method, &context(), CallOutcome::Ok, Credits(1));

        meter.restore(unsaved);

        let drained = meter.drain();
        assert_eq!(drained.len(), 1);
        assert_eq!((drained[0].calls, drained[0].credits), (2, Credits(2)));
    }
}
