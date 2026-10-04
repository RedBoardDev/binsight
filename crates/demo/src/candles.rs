//! The demo's market data: the candles of a chart, drawn from the pool's price path.
//!
//! Each candle reads the bin of every minute it covers (up to now): it opens on the first, closes
//! on the last, and its high and low are the highest and lowest bins. Movements run at the bin of
//! their minute, so each one falls inside its candle, and the last candle of an open position
//! holds its active bin. Prices are exact bin prices; the demo reports no volume.

use binsight_core::price::Price;
use binsight_dlmm::math::{price_from_bin, unit_price};
use binsight_engine::portfolio::ReadError;
use binsight_engine::portfolio::query::CandleRequest;
use binsight_engine::portfolio::views::{
    CandleSource, CandleStatus, CandleView, CandlesUnavailable, CandlesView,
};
use binsight_ledger::facts::PoolFacts;
use jiff::{SignedDuration, Timestamp};

use crate::generate::PricePath;

/// A minute, the step of the price path.
const MINUTE: SignedDuration = SignedDuration::from_mins(1);

/// The candles `request` asks for, read at `now` on `path` (`None` for a pool the demo's market
/// data does not know).
///
/// # Errors
///
/// Returns [`ReadError::BinOutOfRange`] when a bin of the path has no price.
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
    let mut start = aligned(request.from, step);
    while start <= request.to && start <= now {
        let next = start.saturating_add(step).unwrap_or(Timestamp::MAX);
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
        minute = minute.saturating_add(MINUTE).unwrap_or(Timestamp::MAX);
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
fn aligned(instant: Timestamp, step: SignedDuration) -> Timestamp {
    let seconds = step.as_secs().max(1);
    let second = instant.as_second();
    Timestamp::from_second(second.saturating_sub(second.rem_euclid(seconds))).unwrap_or(instant)
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
mod tests {
    use binsight_engine::portfolio::query::{IntervalChoice, candle_request};
    use binsight_engine::portfolio::{PositionRow, Scope};
    use binsight_ledger::facts::PositionId;
    use jiff::tz::TimeZone;

    use super::*;
    use crate::scenario::DEMO_SEED;
    use crate::world::{World, WorldSpec};

    const ANCHOR: &str = "2026-10-04T15:30:20Z";

    fn world() -> World {
        let spec = WorldSpec {
            seed: DEMO_SEED,
            anchor: ANCHOR.parse().unwrap(),
            timezone: TimeZone::get("Europe/Paris").unwrap(),
        };
        World::generate(&spec).unwrap()
    }

    fn candles_of(world: &World, id: PositionId, choice: IntervalChoice) -> CandlesView {
        let now = ANCHOR.parse().unwrap();
        let request = candle_request(&world.snapshot, id, choice, now).unwrap();
        candles(&request, world.paths.get(&request.pool.address), now).unwrap()
    }

    /// The positions to check: every open one and a slice of the closed ones.
    fn positions(world: &World) -> Vec<PositionId> {
        let open = world.snapshot.open_in(Scope::All).map(|row| row.facts.id);
        let closed = world.snapshot.closed_in(Scope::All).map(|row| row.facts.id);
        open.chain(closed.take(60)).collect()
    }

    #[test]
    fn draws_contiguous_candles_that_hold_their_open_and_close() {
        let world = world();
        for id in positions(&world) {
            let view = candles_of(&world, id, IntervalChoice::Auto);
            let step = view.interval.duration();

            assert!(!view.candles.is_empty(), "{id}");
            for pair in view.candles.windows(2) {
                assert_eq!(pair[0].start.saturating_add(step).unwrap(), pair[1].start);
            }
            for candle in &view.candles {
                assert!(
                    candle.low <= candle.open && candle.open <= candle.high,
                    "{id}"
                );
                assert!(
                    candle.low <= candle.close && candle.close <= candle.high,
                    "{id}"
                );
            }
        }
    }

    #[test]
    fn puts_every_movement_and_the_active_bin_inside_their_candle() {
        let world = world();
        for id in positions(&world) {
            let view = candles_of(&world, id, IntervalChoice::Auto);
            let position = world.snapshot.position(id).unwrap();
            let pool = world.snapshot.pool(position.pool()).unwrap();
            let step = view.interval.duration();
            let candle_at = |at: Timestamp| {
                view.candles
                    .iter()
                    .find(|candle| {
                        candle.start <= at && at < candle.start.saturating_add(step).unwrap()
                    })
                    .unwrap()
            };
            for event in world.snapshot.events_of(id) {
                let Some(bin) = event.active_bin_id else {
                    continue;
                };
                let candle = candle_at(event.at);
                let marker = price(pool, bin).unwrap();
                assert!(candle.low <= marker && marker <= candle.high, "{id}");
            }
            if let PositionRow::Open(row) = position {
                let last = view.candles.last().unwrap();
                let active = price(pool, row.facts.active_bin_id).unwrap();
                assert!(last.low <= active && active <= last.high, "{id}");
            }
        }
    }

    #[test]
    fn draws_the_same_candles_for_the_same_world() {
        let (first, second) = (world(), world());
        let id = positions(&first)[0];

        assert_eq!(
            candles_of(&first, id, IntervalChoice::Auto),
            candles_of(&second, id, IntervalChoice::Auto)
        );
    }

    #[test]
    fn answers_unavailable_for_a_pool_the_market_data_does_not_know() {
        let world = world();
        let pool = world.unindexed_pool.unwrap();
        let row = world
            .snapshot
            .closed_in(Scope::All)
            .find(|row| row.facts.pool == pool)
            .unwrap();
        let now = ANCHOR.parse().unwrap();
        let request = candle_request(&world.snapshot, row.facts.id, IntervalChoice::Auto, now);

        let view = candles(&request.unwrap(), None, now).unwrap();

        assert_eq!(view.candles, Vec::new());
        assert_eq!(
            view.status,
            CandleStatus::Unavailable {
                reason: CandlesUnavailable::PoolNotIndexed,
                retry_after_seconds: None,
            }
        );
    }
}
