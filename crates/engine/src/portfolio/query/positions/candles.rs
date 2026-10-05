//! What a read of candles asks the market data source for: the pool, the candle size and the
//! window of the position's chart. The source then answers with the candles themselves.

use binsight_ledger::facts::{PoolFacts, PositionId};
use jiff::Timestamp;

use super::chart::{auto_interval, chart_window, fitting_intervals};
use crate::portfolio::read_error::ReadError;
use crate::portfolio::snapshot::Snapshot;
use crate::portfolio::views::CandleInterval;

/// Which candle size a read asks for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum IntervalChoice {
    /// The size that suits the chart's window.
    Auto,
    /// This size; it must be one the chart offers.
    Fixed(CandleInterval),
}

/// The candles a position's chart needs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CandleRequest {
    /// The pool whose prices they show.
    pub pool: PoolFacts,
    /// Their size.
    pub interval: CandleInterval,
    /// The first instant of the chart.
    pub from: Timestamp,
    /// The last instant of the chart.
    pub to: Timestamp,
    /// Whether the window is over, so the candles will never change.
    pub is_final: bool,
}

/// The candles the chart of position `id` needs, at `now`.
///
/// # Errors
///
/// Returns [`ReadError::PositionNotFound`] when no tracked wallet holds or held it, and
/// [`ReadError::InvalidInterval`] when the size asked for does not fit the chart.
pub fn candle_request(
    snapshot: &Snapshot,
    id: PositionId,
    choice: IntervalChoice,
    now: Timestamp,
) -> Result<CandleRequest, ReadError> {
    let position = snapshot
        .position(id)
        .ok_or(ReadError::PositionNotFound(id))?;
    let pool = snapshot
        .pool(position.pool())
        .ok_or(ReadError::MissingFact)?;
    let window = chart_window(position, now);
    let interval = match choice {
        IntervalChoice::Auto => auto_interval(&window),
        IntervalChoice::Fixed(interval) if fitting_intervals(&window).contains(&interval) => {
            interval
        }
        IntervalChoice::Fixed(_) => return Err(ReadError::InvalidInterval),
    };
    Ok(CandleRequest {
        pool: pool.clone(),
        interval,
        from: window.from,
        to: window.to,
        is_final: window.is_final,
    })
}
