//! Cutting a window into local days, ISO weeks or calendar months.

use jiff::civil::Date;
use jiff::tz::TimeZone;
use jiff::{Timestamp, ToSpan};

use super::{Window, WindowError, local_day, midnight};

/// The size of the buckets a window is cut into.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Bucket {
    /// Local dates.
    Day,
    /// ISO weeks, from Monday.
    Week,
    /// Calendar months.
    Month,
}

/// A span of time: from `start` (included) to `end` (excluded).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct TimeSpan {
    /// The first instant.
    pub start: Timestamp,
    /// The instant right after the span.
    pub end: Timestamp,
}

/// The buckets of `window`, in order. They cover the window exactly: the first starts at its
/// start, each starts where the previous ends, and the last ends at its end; the first and the
/// last are cut at the window's bounds.
///
/// # Errors
///
/// Returns [`WindowError`] when a boundary falls outside the supported range of dates.
pub fn buckets(
    window: &Window,
    bucket: Bucket,
    timezone: &TimeZone,
) -> Result<Vec<TimeSpan>, WindowError> {
    let mut spans = Vec::new();
    let mut start = window.start;
    while start < window.end {
        let next_day = next_boundary(local_day(start, timezone), bucket)?;
        let end = midnight(next_day, timezone)?.min(window.end);
        if end <= start {
            return Err(WindowError);
        }
        spans.push(TimeSpan { start, end });
        start = end;
    }
    Ok(spans)
}

/// The first date of the bucket after the one holding `day`.
fn next_boundary(day: Date, bucket: Bucket) -> Result<Date, WindowError> {
    let next = match bucket {
        Bucket::Day => day.checked_add(1.day()),
        Bucket::Week => {
            let days_since_monday = i64::from(day.weekday().to_monday_zero_offset());
            day.checked_add(7_i64.saturating_sub(days_since_monday).days())
        }
        Bucket::Month => day.first_of_month().checked_add(1.month()),
    };
    next.map_err(|_| WindowError)
}

#[cfg(test)]
mod tests {
    use proptest::prelude::*;

    use super::super::{Period, Window};
    use super::*;

    const ZONES: [&str; 5] = [
        "UTC",
        "Europe/Paris",
        "America/New_York",
        "Asia/Kolkata",
        "Pacific/Chatham",
    ];

    fn at(text: &str) -> Timestamp {
        text.parse().unwrap()
    }

    #[test]
    fn cuts_weeks_on_mondays_and_the_window_bounds() {
        // 2026-10-04 is a Sunday.
        let window = Window::of_period(
            Period::OneMonth,
            at("2026-10-04T12:00:00Z"),
            &TimeZone::UTC,
            None,
        )
        .unwrap();
        let weeks = buckets(&window, Bucket::Week, &TimeZone::UTC).unwrap();
        assert_eq!(weeks[0].start, at("2026-09-05T00:00:00Z"));
        assert_eq!(weeks[0].end, at("2026-09-07T00:00:00Z"));
        assert_eq!(weeks.last().unwrap().start, at("2026-09-28T00:00:00Z"));
        assert_eq!(weeks.last().unwrap().end, at("2026-10-04T12:00:00Z"));
    }

    #[test]
    fn gives_a_twenty_five_hour_day_when_the_clock_goes_back() {
        let paris = TimeZone::get("Europe/Paris").unwrap();
        let window =
            Window::of_period(Period::SevenDays, at("2026-10-27T12:00:00Z"), &paris, None).unwrap();
        let days = buckets(&window, Bucket::Day, &paris).unwrap();
        let hours: Vec<i64> = days
            .iter()
            .map(|span| span.end.duration_since(span.start).as_hours())
            .collect();
        assert!(hours.contains(&25), "{hours:?}");
    }

    #[test]
    fn gives_no_bucket_for_an_empty_window() {
        let now = at("2026-10-04T00:00:00Z");
        let window = Window::of_period(Period::Today, now, &TimeZone::UTC, None).unwrap();
        assert_eq!(
            buckets(&window, Bucket::Day, &TimeZone::UTC).unwrap(),
            Vec::new()
        );
    }

    proptest! {
        #[test]
        fn buckets_partition_the_window(
            seconds in 1_735_689_600_i64..1_830_297_600,
            zone in 0_usize..ZONES.len(),
            period in prop::sample::select(vec![
                Period::Today, Period::SevenDays, Period::OneMonth,
                Period::ThreeMonths, Period::OneYear,
            ]),
            bucket in prop::sample::select(vec![Bucket::Day, Bucket::Week, Bucket::Month]),
        ) {
            let timezone = TimeZone::get(ZONES[zone]).unwrap();
            let now = Timestamp::from_second(seconds).unwrap();
            let window = Window::of_period(period, now, &timezone, None).unwrap();
            let spans = buckets(&window, bucket, &timezone).unwrap();
            let mut expected_start = window.start;
            for span in &spans {
                prop_assert_eq!(span.start, expected_start);
                prop_assert!(span.start < span.end);
                expected_start = span.end;
            }
            prop_assert_eq!(expected_start, window.end);
        }
    }
}
