//! `GET /api/v1/positions/{position_id}/candles`: the candles of a position's chart.
//!
//! Candles come from a market data source (the demo world in demo mode), apart from the chart
//! itself: a source that fails answers `200` with an unavailable status, and the chart still
//! draws its range band and markers. Candles only draw the chart: they enter no figure, carry no
//! exactness and are never converted to dollars.

use axum::Json;
use axum::extract::{Path, State};
use axum::http::{HeaderValue, header};
use axum::response::{IntoResponse, Response};
use binsight_core::decimal::format_signed_units;
use binsight_engine::portfolio::query::IntervalChoice;
use binsight_engine::portfolio::views;
use binsight_ledger::report::valued::MoneyUnit;
use jiff::Timestamp;
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use super::chart::CandleInterval;
use super::position_id::parse_position_id;
use crate::app::AppState;
use crate::contract::{ApiQuery, DecimalString};
use crate::error::{ApiError, ErrorBody};

/// Fresh candles of a finished window can be cached for a day.
const CACHE_FINAL: &str = "private, max-age=86400";

/// Live, stale or unavailable candles must be requested again.
const CACHE_LIVE: &str = "no-store";

/// Which candle size.
#[derive(Debug, Clone, Copy, Default, Deserialize, utoipa::IntoParams)]
#[into_params(parameter_in = Query)]
pub(crate) struct CandlesQuery {
    /// `auto` (the default: the chart's `default_interval`) or one of the chart's `intervals`.
    #[param(inline)]
    pub(crate) interval: Option<IntervalParam>,
}

/// A candle size, or `auto`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize, ToSchema)]
pub(crate) enum IntervalParam {
    /// The size that suits the chart.
    #[default]
    #[serde(rename = "auto")]
    Auto,
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

/// The candles of a position's chart.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ToSchema)]
pub(crate) struct PositionCandles {
    /// Their size.
    pub(crate) interval: CandleInterval,
    /// The first instant of the chart.
    pub(crate) from: Timestamp,
    /// The last instant of the chart.
    pub(crate) to: Timestamp,
    /// Where they come from (clients credit `geckoterminal`).
    pub(crate) source: CandleSource,
    /// Whether they could be read.
    pub(crate) status: CandleStatus,
    /// The candles, oldest first; empty when unavailable.
    pub(crate) candles: Vec<Candle>,
}

/// Where candles come from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub(crate) enum CandleSource {
    /// The public API of `GeckoTerminal`.
    Geckoterminal,
    /// The generated demo world.
    Demo,
}

/// Whether candles could be read, tagged by `state`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ToSchema)]
#[serde(tag = "state", rename_all = "snake_case")]
pub(crate) enum CandleStatus {
    /// Read from the source just now.
    Fresh,
    /// Served from the cache while the source fails.
    Stale {
        /// When they were read.
        fetched_at: Timestamp,
    },
    /// Not available: draw the chart without candles.
    Unavailable {
        /// Why.
        reason: CandlesUnavailable,
        /// How long to wait before asking again, in seconds, when known.
        retry_after_seconds: Option<u64>,
    },
}

/// Why candles are not available.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub(crate) enum CandlesUnavailable {
    /// The source cannot be reached.
    SourceUnreachable,
    /// The source refuses more requests for now.
    RateLimited,
    /// The source does not know the pool (too recent or too small).
    PoolNotIndexed,
    /// The source has no trade in the window.
    NoData,
}

/// One candle, in quote tokens per base token (the chart's quote token).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ToSchema)]
pub(crate) struct Candle {
    /// When it starts.
    pub(crate) start: Timestamp,
    /// The first price.
    pub(crate) open: DecimalString,
    /// The highest price.
    pub(crate) high: DecimalString,
    /// The lowest price.
    pub(crate) low: DecimalString,
    /// The last price.
    pub(crate) close: DecimalString,
    /// The volume traded, in dollars; `null` when the source does not say it.
    pub(crate) volume_usd: Option<DecimalString>,
}

impl From<IntervalParam> for IntervalChoice {
    fn from(param: IntervalParam) -> Self {
        let fixed = match param {
            IntervalParam::Auto => return Self::Auto,
            IntervalParam::OneMinute => views::CandleInterval::OneMinute,
            IntervalParam::FiveMinutes => views::CandleInterval::FiveMinutes,
            IntervalParam::FifteenMinutes => views::CandleInterval::FifteenMinutes,
            IntervalParam::OneHour => views::CandleInterval::OneHour,
            IntervalParam::FourHours => views::CandleInterval::FourHours,
            IntervalParam::OneDay => views::CandleInterval::OneDay,
        };
        Self::Fixed(fixed)
    }
}

impl From<&views::CandlesView> for PositionCandles {
    fn from(view: &views::CandlesView) -> Self {
        let price = |price: binsight_core::price::Price| {
            DecimalString::from_canonical(price.to_significant_string())
        };
        Self {
            interval: view.interval.into(),
            from: view.from,
            to: view.to,
            source: match view.source {
                views::CandleSource::GeckoTerminal => CandleSource::Geckoterminal,
                views::CandleSource::Demo => CandleSource::Demo,
            },
            status: status(view.status),
            candles: view
                .candles
                .iter()
                .map(|candle| Candle {
                    start: candle.start,
                    open: price(candle.open),
                    high: price(candle.high),
                    low: price(candle.low),
                    close: price(candle.close),
                    volume_usd: candle.volume_usd.map(|volume| {
                        DecimalString::from_canonical(format_signed_units(
                            volume.0,
                            MoneyUnit::Usd.decimals(),
                        ))
                    }),
                })
                .collect(),
        }
    }
}

/// The wire status of `status`.
fn status(status: views::CandleStatus) -> CandleStatus {
    match status {
        views::CandleStatus::Fresh => CandleStatus::Fresh,
        views::CandleStatus::Stale { fetched_at } => CandleStatus::Stale { fetched_at },
        views::CandleStatus::Unavailable {
            reason,
            retry_after_seconds,
        } => CandleStatus::Unavailable {
            reason: match reason {
                views::CandlesUnavailable::SourceUnreachable => {
                    CandlesUnavailable::SourceUnreachable
                }
                views::CandlesUnavailable::RateLimited => CandlesUnavailable::RateLimited,
                views::CandlesUnavailable::PoolNotIndexed => CandlesUnavailable::PoolNotIndexed,
                views::CandlesUnavailable::NoData => CandlesUnavailable::NoData,
            },
            retry_after_seconds,
        },
    }
}

/// Reads the candles of a position's chart.
#[utoipa::path(
    get,
    path = "/api/v1/positions/{position_id}/candles",
    operation_id = "getPositionCandles",
    tag = "positions",
    security(("session_cookie" = [])),
    params(
        ("position_id" = String, Path, description = "The position's permanent id: `<address>-<opening signature>`, both in base58."),
        CandlesQuery,
    ),
    responses(
        (status = 200, description = "The candles, or why they are unavailable. Fresh candles of closed positions are cached for a day; live, stale and unavailable responses are not stored.", body = PositionCandles),
        (status = 400, description = "The id is invalid, or the interval is not one of the chart's (`invalid_request`).", body = ErrorBody),
        (status = 401, description = "Not signed in (`unauthenticated`).", body = ErrorBody),
        (status = 404, description = "No tracked wallet holds or held this position (`position_not_found`).", body = ErrorBody),
        (status = 503, description = "The engine does not serve figures yet (`data_not_ready`).", body = ErrorBody),
    ),
)]
pub(crate) async fn get_position_candles(
    State(state): State<AppState>,
    Path(position_id): Path<String>,
    ApiQuery(query): ApiQuery<CandlesQuery>,
) -> Result<Response, ApiError> {
    let id = parse_position_id(&position_id)?;
    let choice = query.interval.unwrap_or_default().into();
    let view = state
        .engine
        .read_model()
        .position_candles(id, choice)
        .await?;
    let cache = cache_policy(&view);
    let headers = [(header::CACHE_CONTROL, HeaderValue::from_static(cache))];
    Ok((headers, Json(PositionCandles::from(&view))).into_response())
}

/// Only a successfully fetched, finished window is suitable for a long browser cache.
fn cache_policy(view: &views::CandlesView) -> &'static str {
    if view.is_final && view.status == views::CandleStatus::Fresh {
        CACHE_FINAL
    } else {
        CACHE_LIVE
    }
}

#[cfg(test)]
mod tests;
