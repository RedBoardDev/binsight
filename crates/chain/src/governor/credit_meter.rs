//! Counting the credits every request costs, and refusing requests the budget does not admit.
//!
//! Every request sent is counted with its outcome, retries included, because the provider may
//! bill each one: the meter would rather overstate than understate. The counts (`usage_counts`)
//! are handed over by [`CreditMeter::drain`] for the engine to persist (the chain client does not
//! know the database), and given back by [`CreditMeter::restore`] when they could not be. Before a request
//! leaves, the meter books its cost against the budget (`budget_guard`), which may refuse or
//! defer it; [`CreditMeter::seed`] restores the day's and the cycle's spending from the database
//! at startup, so a restart does not reset the limits.

use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use binsight_core::clock::{Clock, utc_day};
use binsight_core::credits::{CallOutcome, Credits, Priority};
use jiff::civil::Date;

use super::billing_cycle::BillingCycleDay;
use super::budget_guard::{BudgetGuard, CreditStanding};
use super::cost_table::BilledMethod;
use super::daily_budget::{BudgetLimits, Spend, Spending};
use super::usage_counts::{CreditUsage, UsageCounts};
use crate::error::BudgetRefusal;
use crate::rpc::CallContext;

/// Counts the credits spent and guards the budget.
pub struct CreditMeter {
    clock: Arc<dyn Clock>,
    state: Mutex<MeterState>,
}

struct MeterState {
    guard: BudgetGuard,
    counts: UsageCounts,
}

impl CreditMeter {
    /// A meter with nothing spent, budgeting `cycle_credits` per billing cycle starting on
    /// `cycle_day`, with a hard daily limit if `daily_limit` is set.
    pub(crate) fn new(
        clock: Arc<dyn Clock>,
        cycle_credits: Credits,
        cycle_day: BillingCycleDay,
        daily_limit: Option<Credits>,
    ) -> Self {
        let limits = BudgetLimits {
            cycle_credits,
            daily_limit,
        };
        let guard = BudgetGuard::new(limits, cycle_day, clock.now());
        Self {
            clock,
            state: Mutex::new(MeterState {
                guard,
                counts: UsageCounts::default(),
            }),
        }
    }

    /// Sets what was already spent today and in the current billing cycle (today included), as
    /// persisted before a restart.
    pub fn seed(&self, spent_today: Credits, spent_cycle: Credits) {
        let spending = Spending {
            today: spent_today,
            cycle: spent_cycle.max(spent_today),
        };
        self.lock().guard.seed(spending, self.clock.now());
    }

    /// The first day of the current billing cycle, to read its spending back from the database.
    pub fn cycle_first_day(&self) -> Date {
        self.lock().guard.cycle_first_day(self.clock.now())
    }

    /// Where today's and the cycle's spending stand.
    pub fn standing(&self) -> CreditStanding {
        self.lock().guard.standing(self.clock.now())
    }

    /// The credits spent today (UTC), seed included.
    #[cfg(test)]
    pub(crate) fn spent_today(&self) -> Credits {
        self.standing().spent_today
    }

    /// Takes every count gathered since the last drain.
    pub fn drain(&self) -> Vec<CreditUsage> {
        self.lock().counts.drain()
    }

    /// Gives back counts taken by [`CreditMeter::drain`] that could not be persisted, so the next
    /// drain hands them over again. The spending totals are not touched: they already include
    /// them.
    pub fn restore(&self, usages: Vec<CreditUsage>) {
        self.lock().counts.restore(usages);
    }

    /// Books `cost` for a request of `priority` before it is sent, if the budget admits it.
    pub(crate) fn reserve(&self, cost: Credits, priority: Priority) -> Result<(), BudgetRefusal> {
        let spend = Spend {
            priority,
            cost,
            now: self.clock.now(),
        };
        self.lock().guard.book(spend)
    }

    /// Gives back a booking whose request was not sent after all.
    pub(crate) fn release(&self, cost: Credits) {
        self.lock().guard.release(cost, self.clock.now());
    }

    /// Notes that the provider refused a request because the cycle's credits are used up.
    pub(crate) fn provider_refused(&self) {
        self.lock().guard.provider_refused(self.clock.now());
    }

    /// Counts one request that was sent, with how it ended.
    pub(crate) fn record(
        &self,
        method: BilledMethod,
        context: &CallContext,
        outcome: CallOutcome,
        cost: Credits,
    ) {
        let day = utc_day(self.clock.now());
        let mut state = self.lock();
        if outcome == CallOutcome::Ok {
            state.guard.provider_served();
        }
        state.counts.count(day, method, context, outcome, (1, cost));
    }

    /// Counts `units` of `method` the provider delivered without being asked, such as streamed
    /// data, and adds their cost to the spending: they were spent whatever the budget says.
    pub(crate) fn charge(
        &self,
        method: BilledMethod,
        context: &CallContext,
        units: u64,
        cost: Credits,
    ) {
        let now = self.clock.now();
        let mut state = self.lock();
        state.guard.add(cost, now);
        state.counts.count(
            utc_day(now),
            method,
            context,
            CallOutcome::Ok,
            (units, cost),
        );
    }

    /// The refusal every request would meet now, if a hard limit is reached.
    pub(crate) fn hard_refusal(&self) -> Option<BudgetRefusal> {
        self.lock().guard.hard_refusal(self.clock.now())
    }

    fn lock(&self) -> MutexGuard<'_, MeterState> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

impl std::fmt::Debug for CreditMeter {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("CreditMeter")
            .finish_non_exhaustive()
    }
}

#[cfg(test)]
mod tests {
    use binsight_core::clock::FixedClock;
    use jiff::{SignedDuration, Timestamp};

    use binsight_core::credits::Purpose;
    use binsight_solana::Address;

    use super::*;
    use crate::rpc::RpcMethod;

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
        let meter = CreditMeter::new(
            clock.clone(),
            Credits(1_000_000),
            BillingCycleDay::FIRST,
            limit.map(Credits),
        );
        (clock, meter)
    }

    #[test]
    fn refuses_every_call_once_the_daily_hard_limit_is_reached() {
        let (_clock, meter) = meter(Some(2));

        assert_eq!(meter.reserve(Credits(1), Priority::Realtime), Ok(()));
        assert_eq!(meter.reserve(Credits(1), Priority::Realtime), Ok(()));
        let refusal = meter.reserve(Credits(1), Priority::Realtime).unwrap_err();

        let BudgetRefusal::DailyHardLimitReached { limit, resets_at } = refusal else {
            panic!("not the daily limit: {refusal:?}");
        };
        assert_eq!(limit, Credits(2));
        assert_eq!(resets_at.to_string(), "2026-09-22T00:00:00Z");
        assert_eq!(meter.spent_today(), Credits(2));
    }

    #[test]
    fn keeps_the_guard_across_a_restart_once_seeded() {
        let (_clock, meter) = meter(Some(5));

        meter.seed(Credits(5), Credits(5));

        assert!(meter.reserve(Credits(1), Priority::Realtime).is_err());
    }

    #[test]
    fn starts_each_utc_day_with_nothing_spent() {
        let (clock, meter) = meter(Some(1));
        meter.reserve(Credits(1), Priority::Realtime).unwrap();
        assert!(meter.reserve(Credits(1), Priority::Realtime).is_err());

        clock.advance(SignedDuration::from_hours(13)).unwrap();

        assert_eq!(meter.spent_today(), Credits::ZERO);
        assert_eq!(meter.reserve(Credits(1), Priority::Realtime), Ok(()));
    }

    #[test]
    fn refuses_everything_but_an_hourly_probe_once_the_provider_says_the_credits_are_used_up() {
        let (clock, meter) = meter(None);

        meter.provider_refused();
        let refused = meter.reserve(Credits(1), Priority::Realtime);
        clock.advance(SignedDuration::from_hours(1)).unwrap();
        let probe = meter.reserve(Credits(1), Priority::Realtime);
        let method = BilledMethod::Rpc(RpcMethod::GetTransaction);
        meter.record(method, &context(), CallOutcome::Ok, Credits(1));

        assert!(matches!(
            refused,
            Err(BudgetRefusal::CycleQuotaSpent { .. })
        ));
        assert_eq!(probe, Ok(()));
        assert_eq!(meter.reserve(Credits(1), Priority::Realtime), Ok(()));
    }
}
