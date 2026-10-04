//! How much of the billing cycle's credits a request may spend today, as pure arithmetic.
//!
//! The cycle's credits are spread evenly over the days left in it: each day gets an allowance,
//! recomputed from what is left, so a day that borrowed is paid back by the following ones. Each
//! class of request draws on it differently. Live requests always go. Catching up may borrow up
//! to half a day ahead, completeness first. History and valuation follow the clock: their share
//! grows through the UTC day, one hour ahead of it, and history keeps 15 % of it for valuation.
//! A request over its class's share is deferred to the instant its share admits it, never
//! dropped. Two limits are hard: past 98 % of the cycle only live requests go, and at 100 %
//! nothing does; a configured daily limit stops everything for the day. All amounts are whole
//! credits; nothing here reads the clock.

use binsight_core::clock::{start_of_next_utc_day, utc_day};
use binsight_core::credits::{Credits, Priority};
use jiff::Timestamp;
use jiff::civil::Date;

use super::billing_cycle::BillingCycle;
use super::day_pace::{Pace, paced};
use crate::error::BudgetRefusal;

/// The share of the cycle's credits binsight plans to spend; the rest absorbs miscounts.
const USABLE_PERCENT: u128 = 95;

/// From this share of the cycle's credits spent, only live requests go.
const RESERVE_ONLY_PERCENT: u128 = 98;

/// How far catching up may go over the day's allowance, borrowing from the next days.
const CATCH_UP_PERCENT: u128 = 150;

/// The share of the day's pace history may use, leaving the rest to valuation.
const HISTORY_PERCENT: u128 = 85;

/// The share of the day's pace valuation may use.
const VALUATION_PERCENT: u128 = 100;

/// The credits a plan grants per cycle and the optional hard daily limit.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct BudgetLimits {
    /// The credits the billing cycle grants.
    pub(crate) cycle_credits: Credits,
    /// The credits that may be spent per UTC day, at most, if limited.
    pub(crate) daily_limit: Option<Credits>,
}

/// What was already spent.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct Spending {
    /// Today (UTC).
    pub(crate) today: Credits,
    /// In the current billing cycle, today included.
    pub(crate) cycle: Credits,
}

/// A request asking to spend credits.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Spend {
    /// Its class.
    pub(crate) priority: Priority,
    /// What it costs.
    pub(crate) cost: Credits,
    /// When it asks.
    pub(crate) now: Timestamp,
}

/// Today's allowance: what is left of the cycle's usable credits, spread over the days left.
pub(crate) fn daily_allowance(
    limits: BudgetLimits,
    spending: Spending,
    cycle: BillingCycle,
    today: Date,
) -> Credits {
    let usable = u128::from(limits.cycle_credits.0) * USABLE_PERCENT / 100;
    let before_today = u128::from(spending.cycle.0.saturating_sub(spending.today.0));
    let left = usable.saturating_sub(before_today);
    let allowance = left / u128::from(cycle.days_left(today));
    Credits(u64::try_from(allowance).unwrap_or(u64::MAX))
}

/// Whether `spend` may go now, given what was spent; if not, why, and until when.
pub(crate) fn admit(
    limits: BudgetLimits,
    spending: Spending,
    cycle: BillingCycle,
    spend: Spend,
) -> Result<(), BudgetRefusal> {
    let today = utc_day(spend.now);
    let today_after = u128::from(spending.today.0) + u128::from(spend.cost.0);
    let cycle_after = u128::from(spending.cycle.0) + u128::from(spend.cost.0);
    if let Some(limit) = limits.daily_limit
        && today_after > u128::from(limit.0)
    {
        return Err(BudgetRefusal::DailyHardLimitReached {
            limit,
            resets_at: start_of_next_utc_day(today),
        });
    }
    let cycle_credits = u128::from(limits.cycle_credits.0);
    if cycle_after > cycle_credits {
        return Err(BudgetRefusal::CycleQuotaSpent {
            resume_at: cycle.resets_at(),
        });
    }
    if spend.priority == Priority::Realtime {
        return Ok(());
    }
    if cycle_after * 100 > cycle_credits * RESERVE_ONLY_PERCENT {
        return Err(BudgetRefusal::CycleReserveReached {
            resets_at: cycle.resets_at(),
        });
    }
    let allowance = u128::from(daily_allowance(limits, spending, cycle, today).0);
    let pace = match spend.priority {
        Priority::CatchUp if today_after * 100 > allowance * CATCH_UP_PERCENT => Pace::NotToday,
        Priority::Realtime | Priority::CatchUp => Pace::Within,
        Priority::History => paced(today_after, allowance, HISTORY_PERCENT, spend.now),
        Priority::Valuation => paced(today_after, allowance, VALUATION_PERCENT, spend.now),
    };
    match pace {
        Pace::Within => Ok(()),
        Pace::AdmitsAt(until) => Err(BudgetRefusal::Deferred { until }),
        Pace::NotToday => Err(BudgetRefusal::Deferred {
            until: start_of_next_utc_day(today),
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::governor::billing_cycle::BillingCycleDay;

    /// 2026-10-01 (a 31-day cycle starts) at 00:00 UTC.
    const OCTOBER_FIRST: i64 = 1_790_812_800;

    fn at(hours: i64, secs: i64) -> Timestamp {
        Timestamp::from_second(OCTOBER_FIRST + hours * 3_600 + secs).unwrap()
    }

    fn cycle() -> BillingCycle {
        BillingCycle::containing("2026-10-01".parse().unwrap(), BillingCycleDay::FIRST)
    }

    /// The free plan: 1,000,000 credits, so 950,000 usable, 30,645 a day over 31 days.
    fn free() -> BudgetLimits {
        BudgetLimits {
            cycle_credits: Credits(1_000_000),
            daily_limit: None,
        }
    }

    fn spent(today: u64, cycle: u64) -> Spending {
        Spending {
            today: Credits(today),
            cycle: Credits(cycle),
        }
    }

    /// Whether the free plan admits one credit of `priority` at `now`, `today` credits spent
    /// today and the cycle so far.
    fn ask(priority: Priority, today: u64, now: Timestamp) -> Result<(), BudgetRefusal> {
        let spend = Spend {
            priority,
            cost: Credits(1),
            now,
        };
        admit(free(), spent(today, today), cycle(), spend)
    }

    #[test]
    fn spreads_the_remaining_cycle_over_the_remaining_days() {
        let first_day = "2026-10-01".parse().unwrap();
        let last_day = "2026-10-31".parse().unwrap();

        let fresh = daily_allowance(free(), spent(0, 0), cycle(), first_day);
        let late = daily_allowance(free(), spent(0, 900_000), cycle(), last_day);
        let borrowed_today = daily_allowance(free(), spent(40_000, 40_000), cycle(), first_day);

        assert_eq!(fresh, Credits(30_645));
        assert_eq!(late, Credits(50_000));
        assert_eq!(borrowed_today, fresh);
    }

    #[test]
    fn lets_catching_up_borrow_half_a_day_then_defers_it_to_tomorrow() {
        let tomorrow = Err(BudgetRefusal::Deferred { until: at(24, 0) });

        assert_eq!(ask(Priority::CatchUp, 45_966, at(1, 0)), Ok(()));
        assert_eq!(ask(Priority::CatchUp, 45_967, at(1, 0)), tomorrow);
        assert_eq!(ask(Priority::Realtime, 45_967, at(1, 0)), Ok(()));
    }

    #[test]
    fn paces_history_on_the_clock_one_hour_ahead() {
        // At 06:00, seven hours of the day's pace: 0.85 × 30,645 × 7 / 24 = 7,597 credits.
        let ahead = ask(Priority::History, 7_597, at(6, 0));

        assert_eq!(ask(Priority::History, 7_596, at(6, 0)), Ok(()));
        let Err(BudgetRefusal::Deferred { until }) = ahead else {
            panic!("not deferred: {ahead:?}");
        };
        assert!(until > at(6, 0) && until <= at(6, 4), "{until}");
    }

    #[test]
    fn defers_history_to_tomorrow_once_the_day_share_is_spent() {
        let tomorrow = Err(BudgetRefusal::Deferred { until: at(24, 0) });

        assert_eq!(ask(Priority::History, 26_049, at(23, 0)), tomorrow);
    }

    #[test]
    fn gives_valuation_the_whole_pace() {
        assert!(ask(Priority::History, 7_597, at(6, 0)).is_err());
        assert_eq!(ask(Priority::Valuation, 7_597, at(6, 0)), Ok(()));
    }

    #[test]
    fn keeps_only_realtime_above_98_percent_of_the_cycle() {
        let spending = spent(0, 980_000);
        let spend = |priority| Spend {
            priority,
            cost: Credits(1),
            now: at(1, 0),
        };

        let catch_up = admit(free(), spending, cycle(), spend(Priority::CatchUp));
        let realtime = admit(free(), spending, cycle(), spend(Priority::Realtime));

        let resets_at = "2026-11-01T00:00:00Z".parse().unwrap();
        assert_eq!(
            catch_up,
            Err(BudgetRefusal::CycleReserveReached { resets_at })
        );
        assert_eq!(realtime, Ok(()));
    }

    #[test]
    fn refuses_everything_once_the_cycle_is_spent_or_the_daily_limit_reached() {
        let spend = Spend {
            priority: Priority::Realtime,
            cost: Credits(1),
            now: at(1, 0),
        };
        let limited = BudgetLimits {
            daily_limit: Some(Credits(5_000)),
            ..free()
        };

        let cycle_spent = admit(free(), spent(0, 1_000_000), cycle(), spend);
        let day_spent = admit(limited, spent(5_000, 5_000), cycle(), spend);

        let resume_at = "2026-11-01T00:00:00Z".parse().unwrap();
        assert_eq!(
            cycle_spent,
            Err(BudgetRefusal::CycleQuotaSpent { resume_at })
        );
        let limit = Credits(5_000);
        let resets_at = at(24, 0);
        assert_eq!(
            day_spent,
            Err(BudgetRefusal::DailyHardLimitReached { limit, resets_at })
        );
    }
}
