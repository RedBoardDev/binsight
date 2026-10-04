//! `GET /api/v1/stats/series`: a chart series (net worth, real PnL or closed-position PnL)
//! bucket by bucket, each point with its share of the net worth.

use axum::Json;
use axum::extract::State;
use binsight_engine::portfolio::query::SeriesRequest;
use binsight_engine::portfolio::views;
use binsight_ledger::report::period::Bucket as LedgerBucket;
use binsight_ledger::report::series::SeriesKind;
use jiff::Timestamp;
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use crate::app::AppState;
use crate::contract::{
    ApiQuery, CurrencyQuery, Figure, PercentFigure, PeriodQuery, ScopeQuery, Window,
};
use crate::error::{ApiError, ErrorBody};

/// Which series and how its window is cut.
#[derive(Debug, Clone, Copy, Default, Deserialize, utoipa::IntoParams)]
#[into_params(parameter_in = Query)]
pub(crate) struct SeriesQuery {
    /// Which series (`real_pnl` by default).
    pub(crate) series: Option<Series>,
    /// The size of the buckets (`day` by default); a window may have at most 1000 of them.
    pub(crate) bucket: Option<Bucket>,
}

/// Which series.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Series {
    /// The net worth at the end of each bucket (`bar` and the shares are `null`).
    NetWorth,
    /// The real PnL gained in each bucket and since the start of the window (ends on the gain).
    #[default]
    RealPnl,
    /// The PnL of the positions closed in each bucket and since the start of the window.
    Positions,
}

/// The size of the buckets.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Bucket {
    /// Local dates.
    #[default]
    Day,
    /// ISO weeks, from Monday.
    Week,
    /// Calendar months.
    Month,
}

/// A series over a window.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ToSchema)]
pub(crate) struct StatsSeries {
    /// The window.
    pub(crate) window: Window,
    /// Which series.
    pub(crate) series: Series,
    /// The size of its buckets.
    pub(crate) bucket: Bucket,
    /// The headline figures.
    pub(crate) header: SeriesHeader,
    /// One point per bucket; the first and the last are cut at the window's bounds.
    pub(crate) points: Vec<SeriesPoint>,
}

/// The headline figures of a series.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ToSchema)]
pub(crate) struct SeriesHeader {
    /// The net worth now, the gain (equal to the overview's), or the PnL of the positions
    /// closed in the window.
    pub(crate) value: Figure,
    /// For the net worth: its change over the window; otherwise `null`.
    pub(crate) change: Option<Figure>,
    /// For the net worth: the capital put in over the window, net; otherwise `null`.
    pub(crate) net_deposits: Option<Figure>,
}

/// One point of a series.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ToSchema)]
pub(crate) struct SeriesPoint {
    /// The start of its bucket.
    pub(crate) start: Timestamp,
    /// The end of its bucket (now for the last one).
    pub(crate) end: Timestamp,
    /// The change over the bucket.
    pub(crate) bar: Option<Figure>,
    /// The bar as a percentage of the net worth at the start of the bucket.
    pub(crate) bar_share_of_net_worth: Option<PercentFigure>,
    /// The change since the start of the window (the net worth itself for `net_worth`).
    pub(crate) line: Figure,
    /// The line as a percentage of the net worth at the start of the window (the last point's
    /// equals the gain percentage).
    pub(crate) line_share_of_net_worth: Option<PercentFigure>,
}

impl From<views::SeriesView> for StatsSeries {
    fn from(view: views::SeriesView) -> Self {
        Self {
            window: (&view.window).into(),
            series: match view.series {
                SeriesKind::NetWorth => Series::NetWorth,
                SeriesKind::RealPnl => Series::RealPnl,
                SeriesKind::Positions => Series::Positions,
            },
            bucket: match view.bucket {
                LedgerBucket::Day => Bucket::Day,
                LedgerBucket::Week => Bucket::Week,
                LedgerBucket::Month => Bucket::Month,
            },
            header: SeriesHeader {
                value: (&view.header.value).into(),
                change: view.header.change.as_ref().map(Figure::from),
                net_deposits: view.header.net_deposits.as_ref().map(Figure::from),
            },
            points: view
                .points
                .iter()
                .map(|point| SeriesPoint {
                    start: point.start,
                    end: point.end,
                    bar: point.bar.as_ref().map(Figure::from),
                    bar_share_of_net_worth: point
                        .bar_share_of_net_worth
                        .as_ref()
                        .map(PercentFigure::from),
                    line: (&point.line).into(),
                    line_share_of_net_worth: point
                        .line_share_of_net_worth
                        .as_ref()
                        .map(PercentFigure::from),
                })
                .collect(),
        }
    }
}

impl SeriesQuery {
    /// The series and bucket size of the read rules.
    fn kinds(self) -> (SeriesKind, LedgerBucket) {
        let series = match self.series.unwrap_or_default() {
            Series::NetWorth => SeriesKind::NetWorth,
            Series::RealPnl => SeriesKind::RealPnl,
            Series::Positions => SeriesKind::Positions,
        };
        let bucket = match self.bucket.unwrap_or_default() {
            Bucket::Day => LedgerBucket::Day,
            Bucket::Week => LedgerBucket::Week,
            Bucket::Month => LedgerBucket::Month,
        };
        (series, bucket)
    }
}

/// Reads a chart series.
#[utoipa::path(
    get,
    path = "/api/v1/stats/series",
    operation_id = "getStatsSeries",
    tag = "stats",
    security(("session_cookie" = [])),
    params(ScopeQuery, PeriodQuery, SeriesQuery, CurrencyQuery),
    responses(
        (status = 200, description = "The series.", body = StatsSeries),
        (status = 400, description = "A query parameter is invalid, or the window has more than 1000 buckets (`invalid_request`).", body = ErrorBody),
        (status = 401, description = "Not signed in (`unauthenticated`).", body = ErrorBody),
        (status = 404, description = "The wallet is not tracked (`wallet_not_found`).", body = ErrorBody),
        (status = 503, description = "The engine does not serve figures yet (`data_not_ready`).", body = ErrorBody),
    ),
)]
pub(crate) async fn get_stats_series(
    State(state): State<AppState>,
    ApiQuery(scope): ApiQuery<ScopeQuery>,
    ApiQuery(period): ApiQuery<PeriodQuery>,
    ApiQuery(series): ApiQuery<SeriesQuery>,
    ApiQuery(currency): ApiQuery<CurrencyQuery>,
) -> Result<Json<StatsSeries>, ApiError> {
    let (series, bucket) = series.kinds();
    let request = SeriesRequest {
        scope: scope.scope()?,
        period: period.period(),
        series,
        bucket,
        currency: currency.currency(),
    };
    let view = state.engine.read_model().stats_series(request).await?;
    Ok(Json(view.into()))
}
