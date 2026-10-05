//! Time windows and their buckets, in the instance's time zone.
//!
//! A period covers the last N local dates, today included, from local midnight to now; `all`
//! starts at the midnight of the first activity. Buckets (days, ISO weeks, months) cut a window
//! into consecutive spans that cover it exactly, even on the days a clock change makes 23 or 25
//! hours long. This module computes instants; it never reads the clock (`now` is a parameter).

mod buckets;

use jiff::civil::Date;
use jiff::tz::TimeZone;
use jiff::{Timestamp, ToSpan};

pub use buckets::{Bucket, TimeSpan, buckets};

/// A period the owner picks for the figures of a screen.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Period {
    /// Since local midnight.
    Today,
    /// The last 7 local dates.
    SevenDays,
    /// The last month of local dates.
    OneMonth,
    /// The last three months of local dates.
    ThreeMonths,
    /// The last year of local dates.
    OneYear,
    /// Since the first activity.
    All,
}

/// What a window was asked for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum WindowScope {
    /// A period ending now.
    Period(Period),
    /// One local date.
    Day(Date),
}

/// A span of time figures are computed over: from `start` (included) to `end` (excluded).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct Window {
    /// What the window was asked for.
    pub scope: WindowScope,
    /// The first instant of the window.
    pub start: Timestamp,
    /// The instant right after the window: now, or the next midnight for a past day.
    pub end: Timestamp,
}

/// A window falls outside the range of dates binsight can represent.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
#[error("the time window falls outside the supported range of dates")]
pub struct WindowError;

impl Window {
    /// The window of `period` at `now` in `timezone`; `first_activity` starts the `all` period
    /// (today when there is none).
    ///
    /// # Errors
    ///
    /// Returns [`WindowError`] when the start falls outside the supported range of dates.
    pub fn of_period(
        period: Period,
        now: Timestamp,
        timezone: &TimeZone,
        first_activity: Option<Timestamp>,
    ) -> Result<Self, WindowError> {
        let today = local_day(now, timezone);
        let first_day = match period {
            Period::Today => today,
            Period::SevenDays => today.checked_sub(6.days()).map_err(|_| WindowError)?,
            Period::OneMonth => months_back(today, 1)?,
            Period::ThreeMonths => months_back(today, 3)?,
            Period::OneYear => today
                .checked_sub(1.year())
                .and_then(|day| day.checked_add(1.day()))
                .map_err(|_| WindowError)?,
            Period::All => first_activity.map_or(today, |first| local_day(first, timezone)),
        };
        Ok(Self {
            scope: WindowScope::Period(period),
            start: midnight(first_day, timezone)?.min(now),
            end: now,
        })
    }

    /// The window of the local date `day`, cut at `now` when the day is not over.
    ///
    /// # Errors
    ///
    /// Returns [`WindowError`] when the day falls outside the supported range of dates.
    pub fn of_day(day: Date, now: Timestamp, timezone: &TimeZone) -> Result<Self, WindowError> {
        let next_day = day.checked_add(1.day()).map_err(|_| WindowError)?;
        let start = midnight(day, timezone)?;
        Ok(Self {
            scope: WindowScope::Day(day),
            start: start.min(now),
            end: midnight(next_day, timezone)?.min(now),
        })
    }

    /// Whether `instant` falls inside the window.
    pub fn contains(&self, instant: Timestamp) -> bool {
        self.start <= instant && instant < self.end
    }
}

/// The local date of `instant` in `timezone`.
pub fn local_day(instant: Timestamp, timezone: &TimeZone) -> Date {
    instant.to_zoned(timezone.clone()).date()
}

/// The first instant of the local date `day` (midnight, or the first instant that exists when a
/// clock change skips midnight).
///
/// # Errors
///
/// Returns [`WindowError`] when the day falls outside the supported range of dates.
pub fn midnight(day: Date, timezone: &TimeZone) -> Result<Timestamp, WindowError> {
    day.to_zoned(timezone.clone())
        .map(|zoned| zoned.timestamp())
        .map_err(|_| WindowError)
}

/// The first date of a window of `months` months ending on `today`: one day after the same date
/// `months` months earlier (clamped to the end of a shorter month).
fn months_back(today: Date, months: i32) -> Result<Date, WindowError> {
    today
        .checked_sub(months.months())
        .and_then(|day| day.checked_add(1.day()))
        .map_err(|_| WindowError)
}

#[cfg(test)]
mod tests {
    use jiff::civil::date;

    use super::*;

    fn paris() -> TimeZone {
        TimeZone::get("Europe/Paris").unwrap()
    }

    fn at(text: &str) -> Timestamp {
        text.parse().unwrap()
    }

    #[test]
    fn starts_today_at_local_midnight() {
        let window =
            Window::of_period(Period::Today, at("2026-10-04T10:00:00Z"), &paris(), None).unwrap();
        assert_eq!(window.start, at("2026-10-03T22:00:00Z"));
        assert_eq!(window.end, at("2026-10-04T10:00:00Z"));
    }

    #[test]
    fn covers_the_last_seven_local_dates() {
        let window = Window::of_period(
            Period::SevenDays,
            at("2026-10-04T10:00:00Z"),
            &paris(),
            None,
        )
        .unwrap();
        assert_eq!(window.start, at("2026-09-27T22:00:00Z"));
    }

    #[test]
    fn clamps_a_month_back_from_the_end_of_march() {
        let now = at("2026-03-31T12:00:00Z");
        let window = Window::of_period(Period::OneMonth, now, &TimeZone::UTC, None).unwrap();
        // 31 March − 1 month = 28 February (clamped), + 1 day = 1 March.
        assert_eq!(window.start, at("2026-03-01T00:00:00Z"));
    }

    #[test]
    fn starts_all_at_the_first_activity_or_today() {
        let now = at("2026-10-04T10:00:00Z");
        let first = at("2025-04-02T15:00:00Z");
        let all = Window::of_period(Period::All, now, &TimeZone::UTC, Some(first)).unwrap();
        assert_eq!(all.start, at("2025-04-02T00:00:00Z"));
        let empty = Window::of_period(Period::All, now, &TimeZone::UTC, None).unwrap();
        assert_eq!(empty.start, at("2026-10-04T00:00:00Z"));
    }

    #[test]
    fn cuts_a_day_at_now_or_at_the_next_midnight() {
        let now = at("2026-10-04T10:00:00Z");
        let past = Window::of_day(date(2026, 10, 2), now, &TimeZone::UTC).unwrap();
        assert_eq!(past.end, at("2026-10-03T00:00:00Z"));
        let today = Window::of_day(date(2026, 10, 4), now, &TimeZone::UTC).unwrap();
        assert_eq!(today.end, now);
        assert!(today.contains(at("2026-10-04T00:00:00Z")));
        assert!(!today.contains(now));
    }

    #[test]
    fn a_day_with_a_clock_change_lasts_twenty_three_hours() {
        let day = Window::of_day(date(2026, 3, 29), at("2026-04-01T00:00:00Z"), &paris()).unwrap();
        assert_eq!(day.end.duration_since(day.start).as_hours(), 23);
    }
}
