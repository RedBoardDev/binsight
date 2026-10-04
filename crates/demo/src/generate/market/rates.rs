//! The SOL/USD rate of every day of the demo world: a bounded daily random walk.

use std::collections::BTreeMap;

use binsight_core::money::SolUsdRate;
use binsight_ledger::facts::SolUsdRates;
use jiff::ToSpan;
use jiff::civil::Date;

use crate::error::DemoError;
use crate::random::Stream;

/// The rate the walk starts from, in micro-dollars per SOL.
const START_MICRO_USD: i128 = 145_000_000;

/// The lowest and highest rates the walk may reach.
const BOUNDS_MICRO_USD: (i128, i128) = (80_000_000, 300_000_000);

/// The largest daily move, in basis points (a slight upward drift on the positive side).
const DAILY_MOVE_BPS: (i64, i64) = (-300, 310);

/// One in basis points.
const BASIS_POINTS: i128 = 10_000;

/// The closing rate of every UTC day from `first_day` to `last_day`; the spot rate is the last
/// one.
pub(crate) fn sol_usd_rates(
    seed: u64,
    first_day: Date,
    last_day: Date,
) -> Result<SolUsdRates, DemoError> {
    let mut stream = Stream::of(seed, "rates:sol-usd");
    let mut daily = BTreeMap::new();
    let mut micro_usd = START_MICRO_USD;
    let mut day = first_day;
    while day <= last_day {
        let rate = u64::try_from(micro_usd)
            .ok()
            .and_then(SolUsdRate::new)
            .ok_or(DemoError::OutOfRange)?;
        daily.insert(day, rate);
        let change = i128::from(stream.between(DAILY_MOVE_BPS.0, DAILY_MOVE_BPS.1));
        micro_usd = micro_usd
            .checked_mul(BASIS_POINTS.saturating_add(change))
            .and_then(|scaled| scaled.checked_div(BASIS_POINTS))
            .ok_or(DemoError::OutOfRange)?
            .clamp(BOUNDS_MICRO_USD.0, BOUNDS_MICRO_USD.1);
        day = day
            .checked_add(1.day())
            .map_err(|_| DemoError::OutOfRange)?;
    }
    let spot = daily.get(&last_day).copied();
    Ok(SolUsdRates { daily, spot })
}
