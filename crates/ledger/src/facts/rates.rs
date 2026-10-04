//! The SOL/USD rates: one close per UTC day, and the current (spot) rate.
//!
//! Rates are a market series, independent of the instance's time zone, so they are keyed by UTC
//! day. A historical figure is converted at the rate of the UTC day of its instant; a live figure
//! at the spot rate.

use std::collections::BTreeMap;

use binsight_core::money::SolUsdRate;
use jiff::Timestamp;
use jiff::civil::Date;
use jiff::tz::TimeZone;

/// The known SOL/USD rates.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SolUsdRates {
    /// The closing rate of each UTC day.
    pub daily: BTreeMap<Date, SolUsdRate>,
    /// The current rate, if known.
    pub spot: Option<SolUsdRate>,
}

impl SolUsdRates {
    /// The rate of the UTC day of `instant`, if known.
    pub fn on(&self, instant: Timestamp) -> Option<SolUsdRate> {
        let day = instant.to_zoned(TimeZone::UTC).date();
        self.daily.get(&day).copied()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_rate_of_the_utc_day() {
        let rate = SolUsdRate::new(150_000_000).unwrap();
        let rates = SolUsdRates {
            daily: BTreeMap::from([(jiff::civil::date(2026, 10, 4), rate)]),
            spot: None,
        };
        let late_evening: Timestamp = "2026-10-04T23:59:59Z".parse().unwrap();
        let next_day: Timestamp = "2026-10-05T00:00:00Z".parse().unwrap();
        assert_eq!(rates.on(late_evening), Some(rate));
        assert_eq!(rates.on(next_day), None);
    }
}
