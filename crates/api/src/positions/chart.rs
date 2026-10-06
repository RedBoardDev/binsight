//! A position's price chart on the wire: its window, the candle sizes that fit it, the range band
//! over time and a marker per movement. Exact and local, it comes with the position.

use binsight_engine::portfolio::views;
use jiff::Timestamp;
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use crate::contract::{Price, TokenRef};

/// The price chart of a position, always in its pool's quote token (never converted to dollars,
/// so the range band stays exact).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ToSchema)]
pub(crate) struct PositionChart {
    /// The token prices are expressed in.
    pub(crate) quote: TokenRef,
    /// The first instant: a tenth of the position's life before it opened.
    pub(crate) from: Timestamp,
    /// The last instant: now while open, a tenth of its life after it closed otherwise.
    pub(crate) to: Timestamp,
    /// The candle size that suits the window (what `interval=auto` picks).
    pub(crate) default_interval: CandleInterval,
    /// Every candle size that draws the window in at most 1000 candles, smallest first.
    pub(crate) intervals: Vec<CandleInterval>,
    /// The range over time, oldest first (it changes when the position rebalances).
    pub(crate) ranges: Vec<RangeSpan>,
    /// One marker per movement, oldest first.
    pub(crate) markers: Vec<ChartMarker>,
    /// The price now, for an open position; `null` once closed.
    pub(crate) current_price: Option<Price>,
}

/// The size of a candle.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub(crate) enum CandleInterval {
    /// One minute.
    #[serde(rename = "1m")]
    OneMinute,
    /// Five minutes.
    #[serde(rename = "5m")]
    FiveMinutes,
    /// Fifteen minutes.
    #[serde(rename = "15m")]
    FifteenMinutes,
    /// One hour.
    #[serde(rename = "1h")]
    OneHour,
    /// Four hours.
    #[serde(rename = "4h")]
    FourHours,
    /// One day.
    #[serde(rename = "1d")]
    OneDay,
}

/// The range of a position over a span of time.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ToSchema)]
pub(crate) struct RangeSpan {
    /// When the range was set.
    pub(crate) from: Timestamp,
    /// When it changed or the position closed; `null` while it holds.
    pub(crate) to: Option<Timestamp>,
    /// The lower numeric displayed price bound; `null` when the quote cannot be valued.
    pub(crate) lower: Option<Price>,
    /// The upper numeric displayed price bound; `null` when the quote cannot be valued.
    pub(crate) upper: Option<Price>,
}

/// A movement on the chart.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ToSchema)]
pub(crate) struct ChartMarker {
    /// When it happened.
    pub(crate) at: Timestamp,
    /// What it was.
    pub(crate) kind: MovementKind,
    /// The exact bin price of its transaction; `null` when the transaction does not say it.
    pub(crate) price: Option<Price>,
    /// Its transaction signature (base58).
    pub(crate) signature: String,
}

/// What a movement did.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub(crate) enum MovementKind {
    /// The position was created, independently of its deposits.
    Open,
    /// Liquidity was added.
    Add,
    /// Liquidity was withdrawn by a rebalance.
    RebalanceWithdrawal,
    /// Liquidity was redeposited by a rebalance.
    RebalanceDeposit,
    /// A farming reward was claimed in its own mint.
    RewardClaim,
    /// Part of the liquidity was withdrawn.
    Remove,
    /// Fees were claimed.
    Claim,
    /// The position was closed, independently of its withdrawals.
    Close,
}

impl From<&views::ChartView> for PositionChart {
    fn from(chart: &views::ChartView) -> Self {
        Self {
            quote: (&chart.quote).into(),
            from: chart.from,
            to: chart.to,
            default_interval: chart.default_interval.into(),
            intervals: chart.intervals.iter().copied().map(Into::into).collect(),
            ranges: chart
                .ranges
                .iter()
                .map(|span| RangeSpan {
                    from: span.from,
                    to: span.to,
                    lower: span.lower.map(Price::from),
                    upper: span.upper.map(Price::from),
                })
                .collect(),
            markers: chart
                .markers
                .iter()
                .map(|marker| ChartMarker {
                    at: marker.at,
                    kind: marker.kind.into(),
                    price: marker.price.map(Price::from),
                    signature: marker.signature.to_string(),
                })
                .collect(),
            current_price: chart.current_price.map(Price::from),
        }
    }
}

impl From<views::CandleInterval> for CandleInterval {
    fn from(interval: views::CandleInterval) -> Self {
        match interval {
            views::CandleInterval::OneMinute => Self::OneMinute,
            views::CandleInterval::FiveMinutes => Self::FiveMinutes,
            views::CandleInterval::FifteenMinutes => Self::FifteenMinutes,
            views::CandleInterval::OneHour => Self::OneHour,
            views::CandleInterval::FourHours => Self::FourHours,
            views::CandleInterval::OneDay => Self::OneDay,
        }
    }
}

impl From<CandleInterval> for views::CandleInterval {
    fn from(interval: CandleInterval) -> Self {
        match interval {
            CandleInterval::OneMinute => Self::OneMinute,
            CandleInterval::FiveMinutes => Self::FiveMinutes,
            CandleInterval::FifteenMinutes => Self::FifteenMinutes,
            CandleInterval::OneHour => Self::OneHour,
            CandleInterval::FourHours => Self::FourHours,
            CandleInterval::OneDay => Self::OneDay,
        }
    }
}

impl From<views::MovementKind> for MovementKind {
    fn from(kind: views::MovementKind) -> Self {
        match kind {
            views::MovementKind::Open => Self::Open,
            views::MovementKind::Add => Self::Add,
            views::MovementKind::RebalanceWithdrawal => Self::RebalanceWithdrawal,
            views::MovementKind::RebalanceDeposit => Self::RebalanceDeposit,
            views::MovementKind::RewardClaim => Self::RewardClaim,
            views::MovementKind::Remove => Self::Remove,
            views::MovementKind::Claim => Self::Claim,
            views::MovementKind::Close => Self::Close,
        }
    }
}

impl From<MovementKind> for views::MovementKind {
    fn from(kind: MovementKind) -> Self {
        match kind {
            MovementKind::Open => Self::Open,
            MovementKind::Add => Self::Add,
            MovementKind::RebalanceWithdrawal => Self::RebalanceWithdrawal,
            MovementKind::RebalanceDeposit => Self::RebalanceDeposit,
            MovementKind::RewardClaim => Self::RewardClaim,
            MovementKind::Remove => Self::Remove,
            MovementKind::Claim => Self::Claim,
            MovementKind::Close => Self::Close,
        }
    }
}
