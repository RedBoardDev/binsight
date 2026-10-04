//! What was spent today and this billing cycle, and whether one more request may spend.
//!
//! The guard keeps the running totals the daily budget reads: they reset at midnight UTC and at
//! the start of each billing cycle, and are restored from the database at startup so a restart
//! changes nothing. It also remembers that the provider said the cycle's credits were used up:
//! from then on nothing is sent until the cycle ends, except one probe an hour, in case binsight's
//! idea of the cycle is wrong; a probe the provider answers lifts the refusal. The guard takes
//! the time as an argument; the budget rules themselves live in `daily_budget`.

use binsight_core::clock::utc_day;
use binsight_core::credits::{Credits, Priority};
use jiff::civil::Date;
use jiff::{SignedDuration, Timestamp};

use super::billing_cycle::{BillingCycle, BillingCycleDay};
use super::daily_budget::{BudgetLimits, Spend, Spending, admit, daily_allowance};
use crate::error::BudgetRefusal;

/// How often a request is let through to see whether the provider serves again, once it said the
/// cycle's credits were used up.
const PROVIDER_PROBE_INTERVAL_SECS: i64 = 3_600;

/// Where the day's and the cycle's spending stand.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CreditStanding {
    /// The credits spent today (UTC).
    pub spent_today: Credits,
    /// The credits spent in the current billing cycle, today included.
    pub spent_cycle: Credits,
    /// What today may spend: the cycle's usable credits left, spread over its remaining days.
    pub daily_allowance: Credits,
    /// The credits the billing cycle grants.
    pub cycle_credits: Credits,
    /// The first day of the current billing cycle.
    pub cycle_first_day: Date,
    /// Whether every request is refused: the daily limit is reached or the cycle's credits are
    /// spent.
    pub is_refusing_all: bool,
}

/// The running totals and the provider's refusal.
#[derive(Debug)]
pub(crate) struct BudgetGuard {
    limits: BudgetLimits,
    cycle_day: BillingCycleDay,
    day: Date,
    cycle: BillingCycle,
    spending: Spending,
    /// When the provider said the cycle's credits were used up: the next probe's instant.
    provider_refusal: Option<Timestamp>,
}

impl BudgetGuard {
    /// A guard with nothing spent, on the day and cycle of `now`.
    pub(crate) fn new(limits: BudgetLimits, cycle_day: BillingCycleDay, now: Timestamp) -> Self {
        let day = utc_day(now);
        Self {
            limits,
            cycle_day,
            day,
            cycle: BillingCycle::containing(day, cycle_day),
            spending: Spending::default(),
            provider_refusal: None,
        }
    }

    /// Restores what was spent today and this cycle, as persisted.
    pub(crate) fn seed(&mut self, spending: Spending, now: Timestamp) {
        self.roll(now);
        self.spending = spending;
    }

    /// The first day of the cycle `now` falls in.
    pub(crate) fn cycle_first_day(&mut self, now: Timestamp) -> Date {
        self.roll(now);
        self.cycle.first_day()
    }

    /// Books `spend` if the budget admits it.
    pub(crate) fn book(&mut self, spend: Spend) -> Result<(), BudgetRefusal> {
        self.roll(spend.now);
        if let Some(probe_at) = self.provider_refusal {
            if spend.now < probe_at {
                return Err(BudgetRefusal::CycleQuotaSpent {
                    resume_at: probe_at.min(self.cycle.resets_at()),
                });
            }
            self.provider_refusal = Some(next_probe(spend.now));
        }
        admit(self.limits, self.spending, self.cycle, spend)?;
        self.add(spend.cost, spend.now);
        Ok(())
    }

    /// Gives back a booking whose request was never sent.
    pub(crate) fn release(&mut self, cost: Credits, now: Timestamp) {
        self.roll(now);
        self.spending.today = Credits(self.spending.today.0.saturating_sub(cost.0));
        self.spending.cycle = Credits(self.spending.cycle.0.saturating_sub(cost.0));
    }

    /// Adds credits spent without asking (data the provider already streamed).
    pub(crate) fn add(&mut self, cost: Credits, now: Timestamp) {
        self.roll(now);
        self.spending.today = self.spending.today.saturating_add(cost);
        self.spending.cycle = self.spending.cycle.saturating_add(cost);
    }

    /// The provider said the cycle's credits are used up: refuse everything but an hourly probe.
    pub(crate) fn provider_refused(&mut self, now: Timestamp) {
        self.provider_refusal = Some(next_probe(now));
    }

    /// The provider answered a request: whatever it said before, it serves again.
    pub(crate) fn provider_served(&mut self) {
        self.provider_refusal = None;
    }

    /// Whether the hard limits still let anything through.
    pub(crate) fn hard_refusal(&mut self, now: Timestamp) -> Option<BudgetRefusal> {
        self.roll(now);
        if let Some(probe_at) = self.provider_refusal
            && now < probe_at
        {
            return Some(BudgetRefusal::CycleQuotaSpent {
                resume_at: probe_at.min(self.cycle.resets_at()),
            });
        }
        let one_live_credit = Spend {
            priority: Priority::Realtime,
            cost: Credits(1),
            now,
        };
        admit(self.limits, self.spending, self.cycle, one_live_credit).err()
    }

    /// Where the spending stands at `now`.
    pub(crate) fn standing(&mut self, now: Timestamp) -> CreditStanding {
        let is_refusing_all = self.hard_refusal(now).is_some();
        CreditStanding {
            spent_today: self.spending.today,
            spent_cycle: self.spending.cycle,
            daily_allowance: daily_allowance(self.limits, self.spending, self.cycle, self.day),
            cycle_credits: self.limits.cycle_credits,
            cycle_first_day: self.cycle.first_day(),
            is_refusing_all,
        }
    }

    /// Starts a new day, and a new cycle, when `now` reaches them.
    fn roll(&mut self, now: Timestamp) {
        let today = utc_day(now);
        if today == self.day {
            return;
        }
        self.day = today;
        self.spending.today = Credits::ZERO;
        let cycle = BillingCycle::containing(today, self.cycle_day);
        if cycle != self.cycle {
            self.cycle = cycle;
            self.spending.cycle = Credits::ZERO;
            self.provider_refusal = None;
        }
    }
}

/// When the next probe may go, an hour after `now`.
fn next_probe(now: Timestamp) -> Timestamp {
    now.checked_add(SignedDuration::from_secs(PROVIDER_PROBE_INTERVAL_SECS))
        .unwrap_or(Timestamp::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 2026-10-31 at 23:00 UTC, the last hour of a cycle that starts on the first.
    const LAST_HOUR: i64 = 1_793_487_600;

    fn at(secs: i64) -> Timestamp {
        Timestamp::from_second(LAST_HOUR + secs).unwrap()
    }

    fn guard(daily_limit: Option<u64>) -> BudgetGuard {
        let limits = BudgetLimits {
            cycle_credits: Credits(1_000_000),
            daily_limit: daily_limit.map(Credits),
        };
        BudgetGuard::new(limits, BillingCycleDay::FIRST, at(0))
    }

    fn realtime(now: Timestamp) -> Spend {
        Spend {
            priority: Priority::Realtime,
            cost: Credits(1),
            now,
        }
    }

    #[test]
    fn starts_a_new_day_and_a_new_cycle_from_zero() {
        let mut guard = guard(Some(10));
        guard.seed(
            Spending {
                today: Credits(10),
                cycle: Credits(500),
            },
            at(0),
        );
        assert!(guard.book(realtime(at(0))).is_err());

        assert_eq!(guard.book(realtime(at(3_600))), Ok(()));

        let standing = guard.standing(at(3_600));
        assert_eq!(
            (standing.spent_today, standing.spent_cycle),
            (Credits(1), Credits(1))
        );
        assert_eq!(standing.cycle_first_day.to_string(), "2026-11-01");
    }

    #[test]
    fn probes_once_an_hour_after_the_provider_said_the_credits_are_used_up() {
        let mut guard = guard(None);

        guard.provider_refused(at(-7_200));

        assert!(matches!(
            guard.book(realtime(at(-7_140))),
            Err(BudgetRefusal::CycleQuotaSpent { resume_at }) if resume_at == at(-3_600)
        ));
        assert_eq!(guard.book(realtime(at(-3_600))), Ok(()));
        assert!(guard.book(realtime(at(-3_599))).is_err());
        guard.provider_served();
        assert_eq!(guard.book(realtime(at(-3_598))), Ok(()));
    }

    #[test]
    fn gives_back_a_booking_that_was_never_sent() {
        let mut guard = guard(Some(1));
        guard.book(realtime(at(0))).unwrap();

        guard.release(Credits(1), at(0));

        assert_eq!(guard.book(realtime(at(0))), Ok(()));
    }

    #[test]
    fn reports_that_everything_is_refused_once_the_daily_limit_is_spent() {
        let mut guard = guard(Some(2));
        guard.add(Credits(2), at(0));

        assert!(guard.standing(at(0)).is_refusing_all);
        assert!(guard.hard_refusal(at(0)).is_some());
    }
}
