//! `GET /api/v1/overview`: the overview of every wallet, or of one.

mod response;

use axum::Json;
use axum::extract::State;
use binsight_engine::portfolio::query::OverviewRequest;

use crate::app::AppState;
use crate::contract::{ApiQuery, CurrencyQuery, PeriodQuery, ScopeQuery};
use crate::error::{ApiError, ErrorBody};
use response::Overview;

/// Reads the overview of every wallet, or of one.
#[utoipa::path(
    get,
    path = "/api/v1/overview",
    operation_id = "getOverview",
    tag = "portfolio",
    security(("session_cookie" = [])),
    params(ScopeQuery, PeriodQuery, CurrencyQuery),
    responses(
        (status = 200, description = "The overview.", body = Overview),
        (status = 400, description = "A query parameter is invalid (`invalid_request`).", body = ErrorBody),
        (status = 401, description = "Not signed in (`unauthenticated`).", body = ErrorBody),
        (status = 404, description = "The wallet is not tracked (`wallet_not_found`).", body = ErrorBody),
        (status = 503, description = "The engine does not serve figures yet (`data_not_ready`).", body = ErrorBody),
    ),
)]
pub(crate) async fn get_overview(
    State(state): State<AppState>,
    ApiQuery(scope): ApiQuery<ScopeQuery>,
    ApiQuery(period): ApiQuery<PeriodQuery>,
    ApiQuery(currency): ApiQuery<CurrencyQuery>,
) -> Result<Json<Overview>, ApiError> {
    let request = OverviewRequest {
        scope: scope.scope()?,
        period: period.period(),
        currency: currency.currency(),
    };
    let overview = state.engine.read_model().overview(request).await?;
    Ok(Json(overview.into()))
}
