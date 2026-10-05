//! `GET /api/v1/positions/recent-closes`: the positions closed today and yesterday, with each
//! day's totals, and the last close when both days are empty.

use axum::Json;
use axum::extract::State;
use binsight_engine::portfolio::views;
use serde::Serialize;
use utoipa::ToSchema;

use crate::app::AppState;
use crate::contract::{
    ApiQuery, ClosedPositionRow, ClosedTotals, CurrencyQuery, ScopeQuery, Window,
};
use crate::error::{ApiError, ErrorBody};

/// The positions closed today and yesterday.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ToSchema)]
pub(crate) struct RecentCloses {
    /// Today, then yesterday (always both, possibly empty).
    pub(crate) days: Vec<ClosedDay>,
    /// The latest close of all when nothing closed today or yesterday, otherwise `null`.
    pub(crate) last_close: Option<ClosedPositionRow>,
}

/// The positions closed on one local day.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ToSchema)]
pub(crate) struct ClosedDay {
    /// The local date, `YYYY-MM-DD`.
    pub(crate) day: String,
    /// Its window.
    pub(crate) window: Window,
    /// The totals of every position closed that day (today's equal the overview's `today`).
    pub(crate) totals: ClosedTotals,
    /// The latest of them, at most 20.
    pub(crate) items: Vec<ClosedPositionRow>,
    /// How many more closed that day (History shows them).
    pub(crate) remaining_count: usize,
}

impl From<views::RecentClosesView> for RecentCloses {
    fn from(view: views::RecentClosesView) -> Self {
        Self {
            days: view
                .days
                .iter()
                .map(|day| ClosedDay {
                    day: day.day.to_string(),
                    window: (&day.window).into(),
                    totals: (&day.totals).into(),
                    items: day.items.iter().map(ClosedPositionRow::from).collect(),
                    remaining_count: day.remaining_count,
                })
                .collect(),
            last_close: view.last_close.as_ref().map(ClosedPositionRow::from),
        }
    }
}

/// Lists the positions closed today and yesterday.
#[utoipa::path(
    get,
    path = "/api/v1/positions/recent-closes",
    operation_id = "getRecentCloses",
    tag = "portfolio",
    security(("session_cookie" = [])),
    params(ScopeQuery, CurrencyQuery),
    responses(
        (status = 200, description = "Today's and yesterday's closes.", body = RecentCloses),
        (status = 400, description = "A query parameter is invalid (`invalid_request`).", body = ErrorBody),
        (status = 401, description = "Not signed in (`unauthenticated`).", body = ErrorBody),
        (status = 404, description = "The wallet is not tracked (`wallet_not_found`).", body = ErrorBody),
        (status = 503, description = "The engine does not serve figures yet (`data_not_ready`).", body = ErrorBody),
    ),
)]
pub(crate) async fn get_recent_closes(
    State(state): State<AppState>,
    ApiQuery(scope): ApiQuery<ScopeQuery>,
    ApiQuery(currency): ApiQuery<CurrencyQuery>,
) -> Result<Json<RecentCloses>, ApiError> {
    let closes = state
        .engine
        .read_model()
        .recent_closes(scope.scope()?, currency.currency())
        .await?;
    Ok(Json(closes.into()))
}
