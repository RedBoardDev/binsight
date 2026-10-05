//! The candles of a position's price chart. They come from a market data source (or the demo
//! world), never from binsight's own figures: they only draw the chart, enter no figure and
//! carry no exactness.

use binsight_core::money::UsdMicros;
use binsight_core::price::Price;
use binsight_ledger::facts::QuoteAsset;
use jiff::{SignedDuration, Timestamp};

/// The size of a candle.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum CandleInterval {
    /// One minute.
    OneMinute,
    /// Five minutes.
    FiveMinutes,
    /// Fifteen minutes.
    FifteenMinutes,
    /// One hour.
    OneHour,
    /// Four hours.
    FourHours,
    /// One day.
    OneDay,
}

/// Every candle size, smallest first.
pub const CANDLE_INTERVALS: [CandleInterval; 6] = [
    CandleInterval::OneMinute,
    CandleInterval::FiveMinutes,
    CandleInterval::FifteenMinutes,
    CandleInterval::OneHour,
    CandleInterval::FourHours,
    CandleInterval::OneDay,
];

impl CandleInterval {
    /// How long a candle lasts.
    pub fn duration(self) -> SignedDuration {
        let minutes = match self {
            Self::OneMinute => 1,
            Self::FiveMinutes => 5,
            Self::FifteenMinutes => 15,
            Self::OneHour => 60,
            Self::FourHours => 240,
            Self::OneDay => 1_440,
        };
        SignedDuration::from_mins(minutes)
    }
}

/// The candles of a position's chart.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CandlesView {
    /// Their size.
    pub interval: CandleInterval,
    /// The first instant of the chart.
    pub from: Timestamp,
    /// The last instant of the chart.
    pub to: Timestamp,
    /// The token prices are expressed in, when the pool's quote can be valued.
    pub quote: Option<QuoteAsset>,
    /// Where they come from.
    pub source: CandleSource,
    /// Whether they could be read.
    pub status: CandleStatus,
    /// Whether the requested window is over; source status still determines cacheability.
    pub is_final: bool,
    /// The candles, oldest first; empty when unavailable.
    pub candles: Vec<CandleView>,
}

/// One candle: the prices of the pool over its interval, in quote tokens per base token.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CandleView {
    /// When it starts.
    pub start: Timestamp,
    /// The first price.
    pub open: Price,
    /// The highest price.
    pub high: Price,
    /// The lowest price.
    pub low: Price,
    /// The last price.
    pub close: Price,
    /// The volume traded, in dollars, when known.
    pub volume_usd: Option<UsdMicros>,
}

/// Where candles come from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum CandleSource {
    /// The public API of `GeckoTerminal`.
    GeckoTerminal,
    /// The generated demo world.
    Demo,
}

/// Whether candles could be read.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CandleStatus {
    /// Read from the source just now.
    Fresh,
    /// Served from the cache while the source fails.
    Stale {
        /// When they were read.
        fetched_at: Timestamp,
    },
    /// Not available: the chart draws without them.
    Unavailable {
        /// Why.
        reason: CandlesUnavailable,
        /// How long to wait before asking again, in seconds, when the source says it.
        retry_after_seconds: Option<u64>,
    },
}

/// Why candles are not available.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum CandlesUnavailable {
    /// The source cannot be reached.
    SourceUnreachable,
    /// The source refuses more requests for now.
    RateLimited,
    /// The source does not know the pool (too recent or too small).
    PoolNotIndexed,
    /// The source has no trade in the window.
    NoData,
}
