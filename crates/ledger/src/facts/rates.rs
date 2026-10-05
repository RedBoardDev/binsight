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
    /// The currently open UTC day and its provisional rate.
    pub provisional: Option<(Date, SolUsdRate)>,
}

impl SolUsdRates {
    /// The rate of the UTC day of `instant`, if known.
    pub fn on(&self, instant: Timestamp) -> Option<DailyRate> {
        self.on_day(instant.to_zoned(TimeZone::UTC).date())
    }

    /// The effective conversion rate of a UTC day, final before provisional.
    pub fn on_day(&self, day: Date) -> Option<DailyRate> {
        self.daily
            .get(&day)
            .copied()
            .map(DailyRate::Final)
            .or_else(|| {
                self.provisional
                    .filter(|(provisional_day, _)| *provisional_day == day)
                    .map(|(_, rate)| DailyRate::Provisional { day, rate })
            })
    }
}

/// A historical conversion rate, with the quality of its source.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DailyRate {
    /// A completed UTC day's closing rate.
    Final(SolUsdRate),
    /// The still open UTC day's latest observation.
    Provisional {
        /// The still open UTC day.
        day: Date,
        /// Its latest observed rate.
        rate: SolUsdRate,
    },
}

impl DailyRate {
    /// The numeric rate used by a conversion.
    pub fn value(self) -> SolUsdRate {
        match self {
            Self::Final(rate) | Self::Provisional { rate, .. } => rate,
        }
    }
    /// The still open day, absent once the closing rate is final.
    pub fn provisional_day(self) -> Option<Date> {
        match self {
            Self::Final(_) => None,
            Self::Provisional { day, .. } => Some(day),
        }
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
            provisional: None,
        };
        let late_evening: Timestamp = "2026-10-04T23:59:59Z".parse().unwrap();
        let next_day: Timestamp = "2026-10-05T00:00:00Z".parse().unwrap();
        assert_eq!(rates.on(late_evening), Some(DailyRate::Final(rate)));
        assert_eq!(rates.on(next_day), None);
    }
}

#[cfg(test)]
mod provisional_tests {
    use super::*;
    #[test]
    fn uses_provisional_only_for_its_open_day_and_prefers_a_final_close() {
        let day = jiff::civil::date(2026, 10, 5);
        let rate = SolUsdRate::new(150_000_000).unwrap();
        let final_rate = SolUsdRate::new(160_000_000).unwrap();
        let instant: Timestamp = "2026-10-05T12:00:00Z".parse().unwrap();
        let yesterday: Timestamp = "2026-10-04T12:00:00Z".parse().unwrap();
        let mut rates = SolUsdRates {
            provisional: Some((day, rate)),
            ..SolUsdRates::default()
        };
        assert_eq!(
            rates.on(instant),
            Some(DailyRate::Provisional { day, rate })
        );
        assert_eq!(rates.on(yesterday), None);
        rates.daily.insert(day, final_rate);
        assert_eq!(rates.on(instant), Some(DailyRate::Final(final_rate)));
    }
}
