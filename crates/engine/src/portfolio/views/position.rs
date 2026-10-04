//! Positions as the screens show them: the open positions with their range and bins, and one
//! position in the drawer with its chart, its movements and its candles.

mod candles;
mod chart;
mod detail;
mod events;
mod open;

pub use candles::{
    CANDLE_INTERVALS, CandleInterval, CandleSource, CandleStatus, CandleView, CandlesUnavailable,
    CandlesView,
};
pub use chart::{ChartMarker, ChartView, RangeSpan};
pub use detail::{PositionDetailView, PositionState};
pub use events::{
    EventKey, EventPage, MovementKind, PositionEventView, RangeBounds, TokenQuantity,
};
pub use open::{
    BinBar, BinChart, MAX_BIN_BARS, OpenPositionRow, OpenPositionsView, OpenTotals, RangeView,
};
