//! The price chart of a position: its window, the candle sizes that fit it, its range over time
//! and a marker per movement. Everything here is exact and local; the candles come apart.

use binsight_solana::Signature;
use jiff::Timestamp;

use super::candles::CandleInterval;
use super::events::MovementKind;
use crate::portfolio::views::{PriceView, TokenRef};

/// The price chart of a position, always in its pool's quote token.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChartView {
    /// The token prices are expressed in.
    pub quote: TokenRef,
    /// The first instant of the chart.
    pub from: Timestamp,
    /// The last instant of the chart.
    pub to: Timestamp,
    /// The candle size that suits the window.
    pub default_interval: CandleInterval,
    /// Every candle size that fits the window, smallest first.
    pub intervals: Vec<CandleInterval>,
    /// The range over time, oldest first.
    pub ranges: Vec<RangeSpan>,
    /// One marker per movement, oldest first.
    pub markers: Vec<ChartMarker>,
    /// The price now, for an open position.
    pub current_price: Option<PriceView>,
}

/// The range of a position over a span of time.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RangeSpan {
    /// When the range was set.
    pub from: Timestamp,
    /// When it changed or the position closed; `None` while it holds.
    pub to: Option<Timestamp>,
    /// The price of its lowest bin, when the pool's quote can be valued.
    pub lower: Option<PriceView>,
    /// The price of its highest bin, when the pool's quote can be valued.
    pub upper: Option<PriceView>,
}

/// A movement on the chart.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChartMarker {
    /// When it happened.
    pub at: Timestamp,
    /// What it was.
    pub kind: MovementKind,
    /// The bin price of its transaction, when known.
    pub price: Option<PriceView>,
    /// Its transaction.
    pub signature: Signature,
}
