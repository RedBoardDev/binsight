//! The price chart of a position: its window, the candle sizes that fit it, the range band over
//! time and a marker per movement, all from the position's own facts.

use binsight_ledger::facts::{BinRange, PoolFacts, PositionEventFact};
use jiff::{SignedDuration, Timestamp};

use crate::portfolio::query::refs::{bin_price, token_ref};
use crate::portfolio::snapshot::{PositionRow, Snapshot};
use crate::portfolio::views::{
    CANDLE_INTERVALS, CandleInterval, ChartMarker, ChartView, MovementKind, RangeSpan,
};

/// The most candles one chart may draw (one request to the market data source).
pub const MAX_CANDLES: i64 = 1_000;

/// The share of a position's life shown before it opened (and after it closed): a tenth.
const MARGIN_DIVISOR: i32 = 10;

/// The smallest margin around a position's life, so a very short one is still visible.
const MIN_MARGIN: SignedDuration = SignedDuration::from_mins(1);

/// The candle size `auto` picks: the first whose window limit is above the window's length.
const AUTO_INTERVALS: [(SignedDuration, CandleInterval); 5] = [
    (SignedDuration::from_hours(3), CandleInterval::OneMinute),
    (SignedDuration::from_hours(12), CandleInterval::FiveMinutes),
    (
        SignedDuration::from_hours(48),
        CandleInterval::FifteenMinutes,
    ),
    (SignedDuration::from_hours(240), CandleInterval::OneHour),
    (SignedDuration::from_hours(960), CandleInterval::FourHours),
];

/// The span of time a chart covers.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct ChartWindow {
    /// The first instant.
    pub(crate) from: Timestamp,
    /// The last instant.
    pub(crate) to: Timestamp,
    /// Whether the position is closed and the window over, so nothing in it changes anymore.
    pub(crate) is_final: bool,
}

/// The chart of `position` in `pool`, read at `now`.
pub(super) fn chart(
    snapshot: &Snapshot,
    position: PositionRow<'_>,
    pool: &PoolFacts,
    now: Timestamp,
) -> ChartView {
    let window = chart_window(position, now);
    let intervals = fitting_intervals(&window);
    let events = snapshot.events_of(position.id());
    ChartView {
        quote: token_ref(snapshot, &pool.quote),
        from: window.from,
        to: window.to,
        default_interval: auto_interval(&window),
        intervals,
        ranges: range_spans(position, events, pool),
        markers: events
            .iter()
            .map(|event| ChartMarker {
                at: event.at,
                kind: MovementKind::from(&event.kind),
                price: event.active_bin_id.and_then(|bin| bin_price(pool, bin)),
                signature: event.signature,
            })
            .collect(),
        current_price: match position {
            PositionRow::Open(row) => bin_price(pool, row.facts.active_bin_id),
            PositionRow::Closed(_) => None,
        },
    }
}

/// The window of `position`'s chart at `now`.
pub(crate) fn chart_window(position: PositionRow<'_>, now: Timestamp) -> ChartWindow {
    match position {
        PositionRow::Open(row) => window_of_life(row.facts.opened_at, None, now),
        PositionRow::Closed(row) => {
            window_of_life(row.facts.opened_at, Some(row.facts.closed_at), now)
        }
    }
}

/// The window of a life from `opened_at` to `closed_at` (or still open), at `now`: the life
/// with a tenth of it on each side, never beyond now.
fn window_of_life(
    opened_at: Timestamp,
    closed_at: Option<Timestamp>,
    now: Timestamp,
) -> ChartWindow {
    let life = closed_at.unwrap_or(now).duration_since(opened_at);
    let margin = (life / MARGIN_DIVISOR).max(MIN_MARGIN);
    let from = opened_at.saturating_sub(margin).unwrap_or(opened_at);
    let to = match closed_at {
        Some(closed_at) => closed_at
            .saturating_add(margin)
            .unwrap_or(closed_at)
            .min(now),
        None => now,
    };
    ChartWindow {
        from,
        to: to.max(from),
        is_final: closed_at.is_some() && to < now,
    }
}

/// The candle sizes that draw `window` in at most [`MAX_CANDLES`] candles, smallest first.
pub(crate) fn fitting_intervals(window: &ChartWindow) -> Vec<CandleInterval> {
    let length = window.to.duration_since(window.from);
    let fitting: Vec<CandleInterval> = CANDLE_INTERVALS
        .into_iter()
        .filter(|interval| candle_count(length, *interval) <= MAX_CANDLES)
        .collect();
    if fitting.is_empty() {
        return vec![CandleInterval::OneDay];
    }
    fitting
}

/// The candle size that suits `window`.
pub(crate) fn auto_interval(window: &ChartWindow) -> CandleInterval {
    let length = window.to.duration_since(window.from);
    AUTO_INTERVALS
        .iter()
        .find(|(limit, _)| length < *limit)
        .map_or(CandleInterval::OneDay, |(_, interval)| *interval)
}

/// How many candles of `interval` cover `length` (one more for a start between two candles).
fn candle_count(length: SignedDuration, interval: CandleInterval) -> i64 {
    let seconds = interval.duration().as_secs().max(1);
    length
        .as_secs()
        .checked_div(seconds)
        .unwrap_or(i64::MAX)
        .saturating_add(2)
}

/// The range of `position` over time, from its movements; an open position without movements
/// shows its current range from its opening.
fn range_spans(
    position: PositionRow<'_>,
    events: &[PositionEventFact],
    pool: &PoolFacts,
) -> Vec<RangeSpan> {
    let mut changes: Vec<(Timestamp, BinRange)> = events
        .iter()
        .filter_map(|event| event.kind.range().map(|range| (event.at, range)))
        .collect();
    let end = match position {
        PositionRow::Open(row) => {
            if changes.is_empty() {
                let current = BinRange {
                    lower_bin_id: row.facts.lower_bin_id,
                    upper_bin_id: row.facts.upper_bin_id,
                };
                changes.push((row.facts.opened_at, current));
            }
            None
        }
        PositionRow::Closed(row) => Some(row.facts.closed_at),
    };
    let ends = changes
        .iter()
        .skip(1)
        .map(|(at, _)| Some(*at))
        .chain(std::iter::once(end));
    changes
        .iter()
        .zip(ends)
        .map(|((from, range), to)| RangeSpan {
            from: *from,
            to,
            lower: bin_price(pool, range.lower_bin_id),
            upper: bin_price(pool, range.upper_bin_id),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(text: &str) -> Timestamp {
        text.parse().unwrap()
    }

    #[test]
    fn shows_a_tenth_of_a_closed_life_on_each_side() {
        let window = window_of_life(
            at("2026-10-01T00:00:00Z"),
            Some(at("2026-10-01T10:00:00Z")),
            at("2026-10-04T00:00:00Z"),
        );

        assert_eq!(window.from, at("2026-09-30T23:00:00Z"));
        assert_eq!(window.to, at("2026-10-01T11:00:00Z"));
        assert!(window.is_final);
    }

    #[test]
    fn ends_an_open_life_now_and_a_fresh_close_now_too() {
        let now = at("2026-10-04T12:00:00Z");
        let open = window_of_life(at("2026-10-04T02:00:00Z"), None, now);
        let fresh = window_of_life(
            at("2026-10-04T02:00:00Z"),
            Some(at("2026-10-04T11:50:00Z")),
            now,
        );

        assert_eq!((open.from, open.to), (at("2026-10-04T01:00:00Z"), now));
        assert!(!open.is_final);
        assert_eq!(fresh.to, now);
        assert!(!fresh.is_final);
    }

    #[test]
    fn keeps_a_minute_around_a_very_short_life() {
        let opened = at("2026-10-04T10:00:00Z");
        let window = window_of_life(opened, Some(opened), at("2026-10-04T12:00:00Z"));

        assert_eq!(window.from, at("2026-10-04T09:59:00Z"));
        assert_eq!(window.to, at("2026-10-04T10:01:00Z"));
    }

    #[test]
    fn offers_the_sizes_that_fit_a_thousand_candles_and_picks_one_by_length() {
        let window = window_of_life(
            at("2026-09-01T00:00:00Z"),
            Some(at("2026-09-06T00:00:00Z")),
            at("2026-10-04T00:00:00Z"),
        );

        assert_eq!(
            fitting_intervals(&window),
            [
                CandleInterval::FifteenMinutes,
                CandleInterval::OneHour,
                CandleInterval::FourHours,
                CandleInterval::OneDay,
            ]
        );
        assert_eq!(auto_interval(&window), CandleInterval::OneHour);
    }
}
