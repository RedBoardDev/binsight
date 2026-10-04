//! How much of the day's allowance a class may have spent by a given instant of the UTC day.
//!
//! The pace grows evenly from midnight to midnight, one hour ahead of the clock so that the day
//! does not start at zero, and a class gets a share of it. A class ahead of its pace is told the
//! instant the pace catches up, or that it will not today. All amounts are whole credits and
//! whole seconds, in 128 bits so no product overflows; this module is pure.

use binsight_core::clock::utc_day;
use jiff::tz::TimeZone;
use jiff::{SignedDuration, Timestamp};

/// How far ahead of the clock the day's pace runs, so the day does not start at zero.
const PACE_LEAD_SECS: u128 = 3_600;

/// The seconds in a UTC day.
const DAY_SECS: u128 = 86_400;

/// Where a class's spending stands against its share of the day.
pub(super) enum Pace {
    /// Within the share: spend.
    Within,
    /// Over the share until this instant of the day.
    AdmitsAt(Timestamp),
    /// Over the share for the rest of the day.
    NotToday,
}

/// Whether spending up to `today_after` keeps within `share_percent` of the day's pace at `now`,
/// and if not, when the pace admits it.
pub(super) fn paced(
    today_after: u128,
    allowance: u128,
    share_percent: u128,
    now: Timestamp,
) -> Pace {
    let day_start = day_start(now);
    let elapsed =
        u128::try_from(now.as_second().saturating_sub(day_start.as_second())).unwrap_or(0);
    let paced_secs = (elapsed + PACE_LEAD_SECS).min(DAY_SECS);
    let share = share_percent * allowance;
    if today_after * 100 * DAY_SECS <= share * paced_secs {
        return Pace::Within;
    }
    if share == 0 || today_after * 100 > share {
        return Pace::NotToday;
    }
    let needed_secs = (today_after * 100 * DAY_SECS).div_ceil(share);
    let wait_from_start = needed_secs.saturating_sub(PACE_LEAD_SECS);
    let offset = i64::try_from(wait_from_start).unwrap_or(i64::MAX);
    day_start
        .checked_add(SignedDuration::from_secs(offset))
        .map_or(Pace::NotToday, Pace::AdmitsAt)
}

/// Midnight UTC of the day `now` falls on.
fn day_start(now: Timestamp) -> Timestamp {
    utc_day(now)
        .to_zoned(TimeZone::UTC)
        .map_or(now, |midnight| midnight.timestamp())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 2026-10-01 at 00:00 UTC.
    const MIDNIGHT: i64 = 1_790_812_800;

    fn at(secs: i64) -> Timestamp {
        Timestamp::from_second(MIDNIGHT + secs).unwrap()
    }

    #[test]
    fn starts_the_day_one_hour_ahead() {
        // An allowance of 2,400 credits paces 100 an hour: 100 are open at midnight.
        assert!(matches!(paced(100, 2_400, 100, at(0)), Pace::Within));
        assert!(matches!(paced(101, 2_400, 100, at(0)), Pace::AdmitsAt(_)));
    }

    #[test]
    fn says_when_the_pace_catches_up() {
        let Pace::AdmitsAt(until) = paced(250, 2_400, 100, at(0)) else {
            panic!("not paced");
        };

        assert_eq!(until, at(5_400));
    }

    #[test]
    fn says_when_nothing_more_goes_today() {
        assert!(matches!(paced(2_401, 2_400, 100, at(0)), Pace::NotToday));
        assert!(matches!(paced(1, 0, 100, at(0)), Pace::NotToday));
    }
}
