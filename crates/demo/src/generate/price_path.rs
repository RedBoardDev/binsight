//! The price of each pool over time, as a path of whole bin ids.
//!
//! A path stores one bin per hour and adds a small deterministic wobble per minute, so the bin of
//! any instant is known exactly without storing a value per minute. Busy and long-tail pools walk
//! randomly around their reference bin (pulled back when they stray too far); the SOL/USDC pool
//! follows the daily SOL/USD rate, so the two never disagree. Prices are always bin prices: there
//! is no rounding of the generator's own.

use binsight_core::money::SolUsdRate;
use binsight_ledger::facts::SolUsdRates;
use jiff::tz::TimeZone;
use jiff::{SignedDuration, Timestamp};

use super::bins::{bin_at_or_below, raw_price};
use super::catalog::CatalogPool;
use crate::error::DemoError;
use crate::random::{Stream, mixed};

/// Seconds in an hour.
const SECONDS_PER_HOUR: i64 = 3_600;

/// The largest hourly move, in basis points of price.
const HOURLY_MOVE_BPS: i64 = 150;

/// How far a path may stray from its reference before it is pulled back, in basis points of
/// price (about a factor of three each way).
const STRAY_BPS: i64 = 11_000;

/// Micro-dollars per dollar, the denominator of a rate.
const MICRO_PER_UNIT: u128 = 1_000_000;

/// The bin of a pool at every instant of the world.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PricePath {
    first_hour: Timestamp,
    hourly: Vec<i32>,
    noise_seed: u64,
    noise_bins: u64,
}

impl PricePath {
    /// The active bin at `instant`: the hourly bins interpolated, plus the minute's wobble.
    pub(crate) fn bin_at(&self, instant: Timestamp) -> i32 {
        let offset = instant.duration_since(self.first_hour).as_secs().max(0);
        let hour = usize::try_from(offset / SECONDS_PER_HOUR).unwrap_or(usize::MAX);
        let last = self.hourly.len().saturating_sub(1);
        let here = self.hourly.get(hour.min(last)).copied().unwrap_or(0);
        let next = self
            .hourly
            .get(hour.saturating_add(1).min(last))
            .copied()
            .unwrap_or(here);
        let into_hour = offset % SECONDS_PER_HOUR;
        let moved =
            i64::from(next.saturating_sub(here)).saturating_mul(into_hour) / SECONDS_PER_HOUR;
        let minute = u64::try_from(offset / 60).unwrap_or(0);
        let wobble = self.noise_bins.saturating_mul(2).saturating_add(1);
        let noise = i64::try_from(
            mixed(self.noise_seed, minute)
                .checked_rem(wobble)
                .unwrap_or(0),
        )
        .unwrap_or(0)
        .saturating_sub(i64::try_from(self.noise_bins).unwrap_or(0));
        let bin = i64::from(here).saturating_add(moved).saturating_add(noise);
        i32::try_from(bin).unwrap_or(here)
    }
}

/// A random walk of `hours` hours from `first_hour` around the pool's reference bin.
pub(crate) fn random_walk(
    seed: u64,
    pool: &CatalogPool,
    first_hour: Timestamp,
    hours: usize,
) -> PricePath {
    let mut stream = Stream::of(seed, &format!("path:{}", pool.key));
    let step = bins_for_bps(HOURLY_MOVE_BPS, pool.facts.bin_step);
    let stray = bins_for_bps(STRAY_BPS, pool.facts.bin_step);
    let reference = i64::from(pool.reference_bin);
    let mut bin = reference;
    let mut hourly = Vec::with_capacity(hours);
    for _ in 0..hours {
        hourly.push(i32::try_from(bin).unwrap_or(pool.reference_bin));
        let drift = stream.between(step.saturating_neg(), step);
        let pull = match bin.saturating_sub(reference) {
            distance if distance > stray => stream.between(0, step).saturating_neg(),
            distance if distance < stray.saturating_neg() => stream.between(0, step),
            _ => 0,
        };
        bin = bin.saturating_add(drift).saturating_add(pull);
    }
    PricePath {
        first_hour,
        hourly,
        noise_seed: stream.next_u64(),
        noise_bins: u64::try_from(step / 3).unwrap_or(0),
    }
}

/// The path of a SOL/stablecoin pool, following the daily SOL/USD rate hour by hour.
pub(crate) fn following_rates(
    seed: u64,
    pool: &CatalogPool,
    rates: &SolUsdRates,
    first_hour: Timestamp,
    hours: usize,
) -> Result<PricePath, DemoError> {
    let bin_of = |rate: SolUsdRate| -> Result<i32, DemoError> {
        let price = raw_price(
            u128::from(rate.micro_usd_per_sol()),
            MICRO_PER_UNIT,
            pool.facts.base.decimals.0,
            pool.facts.quote.decimals.0,
        )
        .ok_or(DemoError::OutOfRange)?;
        Ok(bin_at_or_below(price, pool.facts.bin_step)?)
    };
    let daily_bins = rates
        .daily
        .iter()
        .map(|(day, rate)| Ok((*day, bin_of(*rate)?)))
        .collect::<Result<std::collections::BTreeMap<_, _>, DemoError>>()?;
    let mut hourly = Vec::with_capacity(hours);
    let mut instant = first_hour;
    for _ in 0..hours {
        let zoned = instant.to_zoned(TimeZone::UTC);
        let today = daily_bins
            .range(..=zoned.date())
            .next_back()
            .map(|(_, bin)| *bin);
        let tomorrow = daily_bins.range(zoned.date()..).nth(1).map(|(_, bin)| *bin);
        let today = today.or(tomorrow).unwrap_or(pool.reference_bin);
        let tomorrow = tomorrow.unwrap_or(today);
        let moved = tomorrow
            .saturating_sub(today)
            .saturating_mul(i32::from(zoned.hour()))
            / 24;
        hourly.push(today.saturating_add(moved));
        instant = instant
            .checked_add(SignedDuration::from_hours(1))
            .map_err(|_| DemoError::OutOfRange)?;
    }
    Ok(PricePath {
        first_hour,
        hourly,
        noise_seed: Stream::of(seed, &format!("path:{}", pool.key)).next_u64(),
        noise_bins: 1,
    })
}

/// How many bins of `bin_step` basis points make about `bps` basis points (at least one).
fn bins_for_bps(bps: i64, bin_step: u16) -> i64 {
    bps.checked_div(i64::from(bin_step)).unwrap_or(1).max(1)
}
