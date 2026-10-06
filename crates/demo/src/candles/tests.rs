//! Candle ranges stay bounded and every timestamp step progresses.

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
        importing_wallet: None,
        profile: crate::world::WorldProfile::Showcase,
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

fn request_of(world: &World) -> CandleRequest {
    let id = world.snapshot.open_in(Scope::All).next().unwrap().facts.id;
    candle_request(
        &world.snapshot,
        id,
        IntervalChoice::Auto,
        ANCHOR.parse().unwrap(),
    )
    .unwrap()
}

#[test]
fn refuses_an_unrepresentable_next_boundary_at_the_maximum_timestamp() {
    let world = world();
    let mut request = request_of(&world);
    request.interval = binsight_engine::portfolio::views::CandleInterval::OneMinute;
    request.from = Timestamp::MAX.checked_sub(MINUTE * 2).unwrap();
    request.to = Timestamp::MAX;

    assert!(matches!(
        candles(
            &request,
            world.paths.get(&request.pool.address),
            Timestamp::MAX,
        ),
        Err(ReadError::Window(_))
    ));
}

#[test]
fn refuses_alignment_before_the_minimum_representable_timestamp() {
    let world = world();
    let mut request = request_of(&world);
    request.interval = binsight_engine::portfolio::views::CandleInterval::OneDay;
    request.from = Timestamp::MIN;
    request.to = Timestamp::MIN;

    assert!(matches!(
        candles(
            &request,
            world.paths.get(&request.pool.address),
            Timestamp::MIN,
        ),
        Err(ReadError::Window(_))
    ));
}

#[test]
fn counts_inclusive_starts_and_accepts_exactly_the_engine_limit() {
    let world = world();
    let mut request = request_of(&world);
    request.interval = binsight_engine::portfolio::views::CandleInterval::OneMinute;
    request.from = "2026-10-01T00:00:00Z".parse().unwrap();
    request.to = request
        .from
        .checked_add(SignedDuration::from_mins(MAX_CANDLES - 1))
        .unwrap();
    let path = world.paths.get(&request.pool.address);
    let view = candles(&request, path, request.to).unwrap();
    assert_eq!(view.candles.len(), usize::try_from(MAX_CANDLES).unwrap());

    request.to = request.to.checked_add(MINUTE).unwrap();
    assert_eq!(
        candles(&request, path, request.to),
        Err(ReadError::TooManyBuckets(
            usize::try_from(MAX_CANDLES).unwrap()
        ))
    );
}

#[test]
fn rejects_a_very_large_window_before_sampling_the_market_path() {
    let world = world();
    let mut request = request_of(&world);
    request.interval = binsight_engine::portfolio::views::CandleInterval::OneDay;
    request.to = Timestamp::MAX;

    assert_eq!(
        candles(
            &request,
            world.paths.get(&request.pool.address),
            Timestamp::MAX,
        ),
        Err(ReadError::TooManyBuckets(
            usize::try_from(MAX_CANDLES).unwrap()
        ))
    );
    let unavailable = candles(&request, None, Timestamp::MAX).unwrap();
    assert!(matches!(
        unavailable.status,
        CandleStatus::Unavailable {
            reason: CandlesUnavailable::PoolNotIndexed,
            ..
        }
    ));
    assert_eq!(unavailable.candles, Vec::<CandleView>::new());
}

#[test]
fn selected_x_candles_invert_bounds_at_each_proved_minute_price() {
    let world = world();
    let mut request = request_of(&world);
    let physical = request.pool.clone();
    request.pool.base.kind = binsight_ledger::facts::TokenKind::Usdc;
    request.pool.quote.kind = binsight_ledger::facts::TokenKind::Other;
    request.pool.base.decimals = binsight_core::units::Decimals(6);
    request.interval = binsight_engine::portfolio::views::CandleInterval::OneHour;
    request.from = "2026-10-04T14:00:00Z".parse().unwrap();
    request.to = "2026-10-04T14:59:00Z".parse().unwrap();
    let path = &world.paths[&physical.address];
    let view = candles(&request, Some(path), request.to).unwrap();
    assert_eq!(view.quote, Some(binsight_ledger::facts::QuoteAsset::Usdc));
    assert_eq!(view.status, CandleStatus::Fresh);
    let candle = view.candles.first().unwrap();
    let mut observed = Vec::new();
    let mut at = request.from;
    while at <= request.to {
        observed.push(price(&request.pool, path.bin_in_minute(at)).unwrap());
        at = at.checked_add(MINUTE).unwrap();
    }
    assert_eq!(candle.open, *observed.first().unwrap());
    assert_eq!(candle.close, *observed.last().unwrap());
    assert_eq!(candle.high, *observed.iter().max().unwrap());
    assert_eq!(candle.low, *observed.iter().min().unwrap());
}

#[test]
fn unsupported_quote_with_a_known_path_keeps_descriptive_physical_candles() {
    let world = world();
    let mut request = request_of(&world);
    request.pool.base.kind = binsight_ledger::facts::TokenKind::Other;
    request.pool.quote.kind = binsight_ledger::facts::TokenKind::Other;
    let path = &world.paths[&request.pool.address];
    let view = candles(&request, Some(path), request.to).unwrap();
    assert_eq!(view.quote, None);
    assert_eq!(view.status, CandleStatus::Fresh);
    assert_ne!(view.candles, Vec::<CandleView>::new());
    for candle in &view.candles {
        let raw = price_from_bin(path.bin_in_minute(candle.start), request.pool.bin_step).unwrap();
        assert_eq!(
            candle.open,
            unit_price(raw, request.pool.base.decimals, request.pool.quote.decimals).unwrap()
        );
        assert!(candle.low <= candle.open && candle.open <= candle.high);
        assert!(candle.low <= candle.close && candle.close <= candle.high);
        assert_eq!(candle.volume_usd, None);
    }
}
