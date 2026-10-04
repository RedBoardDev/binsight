//! `GET /api/v1/positions/{position_id}`: one position for the drawer, open or closed, with the
//! same figures as its row in a list, and its price chart. It answers for any tracked position,
//! whatever the wallet filter, so a permanent link always opens it.

use axum::Json;
use axum::extract::{Path, State};
use binsight_engine::portfolio::query::PositionRequest;
use binsight_engine::portfolio::views;
use serde::Serialize;
use utoipa::ToSchema;

use super::chart::PositionChart;
use super::position_id::parse_position_id;
use crate::app::AppState;
use crate::contract::{ApiQuery, ClosedPositionRow, CurrencyQuery, Freshness, OpenPositionRow};
use crate::error::{ApiError, ErrorBody};

/// A position, tagged by `status`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ToSchema)]
#[serde(tag = "status", rename_all = "snake_case")]
pub(crate) enum PositionDetail {
    /// Still open: valued at its pool's active bin.
    Open(Box<OpenPositionDetail>),
    /// Closed: its figures are final.
    Closed(Box<ClosedPositionDetail>),
}

/// An open position: its row, how fresh it is, and its chart.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ToSchema)]
pub(crate) struct OpenPositionDetail {
    /// The same figures as in the open positions.
    #[serde(flatten)]
    pub(crate) position: OpenPositionRow,
    /// How fresh its figures are.
    pub(crate) freshness: Freshness,
    /// Its price chart.
    pub(crate) chart: PositionChart,
}

/// A closed position: its row and its chart.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ToSchema)]
pub(crate) struct ClosedPositionDetail {
    /// The same figures as in History.
    #[serde(flatten)]
    pub(crate) position: ClosedPositionRow,
    /// Its price chart.
    pub(crate) chart: PositionChart,
}

impl From<views::PositionDetailView> for PositionDetail {
    fn from(view: views::PositionDetailView) -> Self {
        let chart = PositionChart::from(&view.chart);
        match view.position {
            views::PositionState::Open { row, freshness } => {
                Self::Open(Box::new(OpenPositionDetail {
                    position: row.as_ref().into(),
                    freshness: freshness.into(),
                    chart,
                }))
            }
            views::PositionState::Closed(row) => Self::Closed(Box::new(ClosedPositionDetail {
                position: row.as_ref().into(),
                chart,
            })),
        }
    }
}

/// Reads one position with its chart.
#[utoipa::path(
    get,
    path = "/api/v1/positions/{position_id}",
    operation_id = "getPosition",
    tag = "positions",
    security(("session_cookie" = [])),
    params(
        ("position_id" = String, Path, description = "The position's permanent id: `<address>-<opening signature>`, both in base58."),
        CurrencyQuery,
    ),
    responses(
        (status = 200, description = "The position.", body = PositionDetail),
        (status = 400, description = "The id or a query parameter is invalid (`invalid_request`).", body = ErrorBody),
        (status = 401, description = "Not signed in (`unauthenticated`).", body = ErrorBody),
        (status = 404, description = "No tracked wallet holds or held this position (`position_not_found`).", body = ErrorBody),
        (status = 503, description = "The engine does not serve figures yet (`data_not_ready`).", body = ErrorBody),
    ),
)]
pub(crate) async fn get_position(
    State(state): State<AppState>,
    Path(position_id): Path<String>,
    ApiQuery(currency): ApiQuery<CurrencyQuery>,
) -> Result<Json<PositionDetail>, ApiError> {
    let request = PositionRequest {
        id: parse_position_id(&position_id)?,
        currency: currency.currency(),
    };
    let position = state.engine.read_model().position(request).await?;
    Ok(Json(position.into()))
}
