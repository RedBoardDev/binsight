//! The demo's market data: the candles of a chart, drawn from the pool's price path.
//!
//! Each candle reads the bin of every minute it covers (up to now): it opens on the first, closes
//! on the last, and its high and low are the highest and lowest bins. Movements run at the bin of
//! their minute, so each one falls inside its candle, and the last candle of an open position
//! holds its active bin. Prices are exact bin prices; the demo reports no volume.

use binsight_core::price::Price;
use binsight_dlmm::math::{price_from_bin, unit_price};
use binsight_engine::portfolio::ReadError;
use binsight_engine::portfolio::query::{CandleRequest, MAX_CANDLES};
use binsight_engine::portfolio::views::{
    CandleSource, CandleStatus, CandleView, CandlesUnavailable, CandlesView,
};
use binsight_ledger::facts::PoolFacts;
use binsight_ledger::report::period::WindowError;
use jiff::{SignedDuration, Timestamp};

use crate::generate::PricePath;

/// A minute, the step of the price path.
const MINUTE: SignedDuration = SignedDuration::from_mins(1);

/// The candles `request` asks for, read at `now` on `path` (`None` for a pool the demo's market
/// data does not know).
///
/// # Errors
///
/// Returns [`ReadError::BinOutOfRange`] when a bin of the path has no price,
/// [`ReadError::TooManyBuckets`] when the window exceeds [`MAX_CANDLES`], and
/// [`ReadError::Window`] when an aligned boundary or time step is not representable.
pub(crate) fn candles(
    request: &CandleRequest,
    path: Option<&PricePath>,
    now: Timestamp,
) -> Result<CandlesView, ReadError> {
    let mut view = CandlesView {
        interval: request.interval,
        from: request.from,
        to: request.to,
        quote: request.pool.quote_asset(),
        source: CandleSource::Demo,
        status: CandleStatus::Fresh,
        is_final: request.is_final,
        candles: Vec::new(),
    };
    let Some(path) = path else {
        view.status = CandleStatus::Unavailable {
            reason: CandlesUnavailable::PoolNotIndexed,
            retry_after_seconds: None,
        };
        return Ok(view);
    };
    let step = request.interval.duration();
    let mut start = aligned(request.from, step)?;
    let until = request.to.min(now);
    validate_count(start, until, step)?;
    while start <= until {
        let next = start.checked_add(step).map_err(|_| WindowError)?;
        view.candles
            .push(candle(path, &request.pool, (start, next), now)?);
        start = next;
    }
    Ok(view)
}

/// The candle of the minutes from `start` to `next` (excluded), up to `now`.
fn candle(
    path: &PricePath,
    pool: &PoolFacts,
    (start, next): (Timestamp, Timestamp),
    now: Timestamp,
) -> Result<CandleView, ReadError> {
    let open = path.bin_in_minute(start);
    let (mut high, mut low, mut close) = (open, open, open);
    let mut minute = start;
    while minute < next && minute <= now {
        let bin = path.bin_in_minute(minute);
        high = high.max(bin);
        low = low.min(bin);
        close = bin;
        minute = minute.checked_add(MINUTE).map_err(|_| WindowError)?;
    }
    Ok(CandleView {
        start,
        open: price(pool, open)?,
        high: price(pool, high)?,
        low: price(pool, low)?,
        close: price(pool, close)?,
        volume_usd: None,
    })
}

/// The start of the interval of `step` (counted from the Unix epoch, as market data sources do)
/// that `instant` falls in.
fn aligned(instant: Timestamp, step: SignedDuration) -> Result<Timestamp, ReadError> {
    let second = instant.as_second();
    let remainder = second
        .checked_rem_euclid(step.as_secs())
        .ok_or(WindowError)?;
    let start = second.checked_sub(remainder).ok_or(WindowError)?;
    Timestamp::from_second(start).map_err(|_| WindowError.into())
}

/// Count inclusive aligned starts before generating any minute samples.
fn validate_count(
    start: Timestamp,
    until: Timestamp,
    step: SignedDuration,
) -> Result<(), ReadError> {
    if start > until {
        return Ok(());
    }
    let count = until
        .duration_since(start)
        .as_secs()
        .checked_div(step.as_secs())
        .and_then(|count| count.checked_add(1))
        .ok_or(WindowError)?;
    if count > MAX_CANDLES {
        let limit = usize::try_from(MAX_CANDLES).map_err(|_| WindowError)?;
        return Err(ReadError::TooManyBuckets(limit));
    }
    Ok(())
}

/// The unit price of `bin_id` in `pool`.
fn price(pool: &PoolFacts, bin_id: i32) -> Result<Price, ReadError> {
    let out_of_range = || ReadError::BinOutOfRange {
        pool: pool.address,
        bin_id,
    };
    let raw = price_from_bin(bin_id, pool.bin_step).map_err(|_| out_of_range())?;
    unit_price(raw, pool.base.decimals, pool.quote.decimals).map_err(|_| out_of_range())
}

#[cfg(test)]
mod tests;
