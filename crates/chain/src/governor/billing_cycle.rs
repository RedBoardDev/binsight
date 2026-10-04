//! The provider's billing cycle: the month of credits a plan grants, from a start day to the same
//! day of the next month.
//!
//! Helius resets a plan's credits once a month, on the day the subscription started, at midnight
//! UTC. The start day is limited to 1–28 so that every month has it. This module names the cycle
//! containing a day and how many days it has left; it is pure, and how the credits are spread
//! over those days is `daily_budget`'s job.

use std::fmt;

use binsight_core::clock::start_of_next_utc_day;
use jiff::Timestamp;
use jiff::civil::Date;

/// The last start day every month has.
const LAST_START_DAY: u8 = 28;

/// The day of the month a billing cycle starts on, from 1 to 28.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct BillingCycleDay(u8);

/// A billing cycle start day outside 1–28.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
#[error("{day} is not a billing cycle start day (1 to {LAST_START_DAY})")]
pub struct InvalidCycleDay {
    /// The refused day.
    pub day: u8,
}

impl BillingCycleDay {
    /// Cycles that start on the first of the month, the default.
    pub const FIRST: Self = Self(1);

    /// The day of the month, from 1 to 28.
    pub const fn get(self) -> u8 {
        self.0
    }

    /// The first day of the billing cycle `day` falls in.
    pub fn cycle_start(self, day: Date) -> Date {
        BillingCycle::containing(day, self).first_day()
    }
}

impl TryFrom<u8> for BillingCycleDay {
    type Error = InvalidCycleDay;

    /// Accepts a day from 1 to 28.
    fn try_from(day: u8) -> Result<Self, Self::Error> {
        if (1..=LAST_START_DAY).contains(&day) {
            Ok(Self(day))
        } else {
            Err(InvalidCycleDay { day })
        }
    }
}

impl fmt::Display for BillingCycleDay {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}", self.0)
    }
}

/// One billing cycle, from its first day to the day before the next one starts.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct BillingCycle {
    first_day: Date,
    next_first_day: Date,
}

impl BillingCycle {
    /// The cycle that `day` falls in, for cycles starting on `start`.
    pub(crate) fn containing(day: Date, start: BillingCycleDay) -> Self {
        let start_day = i8::try_from(start.get()).unwrap_or(1);
        let this_month = month_day(day, start_day);
        let first_day = if day >= this_month {
            this_month
        } else {
            month_day(previous_month(day), start_day)
        };
        Self {
            first_day,
            next_first_day: month_day(next_month(first_day), start_day),
        }
    }

    /// The cycle's first day.
    pub(crate) const fn first_day(self) -> Date {
        self.first_day
    }

    /// When the next cycle starts, and the credits with it.
    pub(crate) fn resets_at(self) -> Timestamp {
        self.next_first_day
            .yesterday()
            .map_or(Timestamp::MAX, start_of_next_utc_day)
    }

    /// How many days are left in the cycle from `today`, today included (at least one).
    pub(crate) fn days_left(self, today: Date) -> u64 {
        let days = today
            .until(self.next_first_day)
            .map_or(1, |span| span.get_days());
        u64::try_from(days).unwrap_or(1).max(1)
    }
}

/// The day numbered `day_of_month` (at most 28) of `day`'s month.
fn month_day(day: Date, day_of_month: i8) -> Date {
    Date::new(day.year(), day.month(), day_of_month).unwrap_or(day)
}

/// A day of the month before `day`'s.
fn previous_month(day: Date) -> Date {
    day.first_of_month().yesterday().unwrap_or(day)
}

/// A day of the month after `day`'s.
fn next_month(day: Date) -> Date {
    day.last_of_month().tomorrow().unwrap_or(day)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn day(text: &str) -> Date {
        text.parse().unwrap()
    }

    fn cycle_day(day: u8) -> BillingCycleDay {
        BillingCycleDay::try_from(day).unwrap()
    }

    #[test]
    fn accepts_only_days_every_month_has() {
        assert!(BillingCycleDay::try_from(0).is_err());
        assert!(BillingCycleDay::try_from(29).is_err());
        assert_eq!(cycle_day(28).get(), 28);
    }

    #[test]
    fn starts_the_cycle_on_its_day_of_this_month_once_reached() {
        let cycle = BillingCycle::containing(day("2026-10-20"), cycle_day(15));

        assert_eq!(cycle.first_day(), day("2026-10-15"));
        assert_eq!(cycle.resets_at().to_string(), "2026-11-15T00:00:00Z");
    }

    #[test]
    fn starts_the_cycle_last_month_before_its_day() {
        let cycle = BillingCycle::containing(day("2026-01-03"), cycle_day(15));

        assert_eq!(cycle.first_day(), day("2025-12-15"));
        assert_eq!(cycle.resets_at().to_string(), "2026-01-15T00:00:00Z");
    }

    #[test]
    fn counts_the_days_left_today_included() {
        let cycle = BillingCycle::containing(day("2026-02-01"), BillingCycleDay::FIRST);

        assert_eq!(cycle.days_left(day("2026-02-01")), 28);
        assert_eq!(cycle.days_left(day("2026-02-28")), 1);
    }
}
