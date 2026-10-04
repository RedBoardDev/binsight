//! `GET /api/v1/positions/open`: the open positions with their range, bins and figures, sorted
//! by the server (comparing amounts is computing), and their totals.

use axum::Json;
use axum::extract::State;
use binsight_engine::portfolio::query::{OpenPositionsRequest, OpenSort, SortOrder};
use binsight_engine::portfolio::views;
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use crate::app::AppState;
use crate::contract::{
    ApiQuery, CurrencyQuery, Figure, Freshness, OpenPositionRow, Order, PercentFigure, ScopeQuery,
};
use crate::error::{ApiError, ErrorBody};

/// How the open positions are sorted.
#[derive(Debug, Clone, Copy, Default, Deserialize, utoipa::IntoParams)]
#[into_params(parameter_in = Query)]
pub(crate) struct OpenSortQuery {
    /// What to sort by (`range` by default: out of range first, longest out first, then the
    /// in-range ones closest to an edge).
    #[param(inline)]
    pub(crate) sort: Option<SortKey>,
    /// The direction (`asc` for `range` and `pair`, `desc` otherwise, by default).
    #[param(inline)]
    pub(crate) order: Option<Order>,
}

/// What open positions are sorted by.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub(crate) enum SortKey {
    /// Attention first.
    #[default]
    Range,
    /// Value.
    Value,
    /// Open PnL.
    Pnl,
    /// Fees, claimed and unclaimed.
    Fees,
    /// Unclaimed fees.
    Unclaimed,
    /// Daily return.
    Dpr,
    /// Time open.
    Age,
    /// Pair, alphabetically.
    Pair,
}

/// The open positions and their totals.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ToSchema)]
pub(crate) struct OpenPositions {
    /// The positions, sorted as asked.
    pub(crate) items: Vec<OpenPositionRow>,
    /// Always `null`: the list is never paged.
    pub(crate) next_cursor: Option<String>,
    /// How fresh the figures are.
    pub(crate) freshness: Freshness,
    /// The totals (`value` equals the net worth's `lp`, `unclaimed_fees` its unclaimed fees).
    pub(crate) totals: OpenTotals,
}

/// The totals of the open positions.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ToSchema)]
pub(crate) struct OpenTotals {
    /// How many.
    pub(crate) count: usize,
    /// How many are out of range.
    pub(crate) out_of_range_count: usize,
    /// Their value.
    pub(crate) value: Figure,
    /// What they invested.
    pub(crate) invested: Figure,
    /// What they withdrew.
    pub(crate) withdrawn: Figure,
    /// invested − withdrawn.
    pub(crate) net_invested: Figure,
    /// The fees they claimed.
    pub(crate) claimed_fees: Figure,
    /// The fees they could claim.
    pub(crate) unclaimed_fees: Figure,
    /// claimed + unclaimed fees.
    pub(crate) fees: Figure,
    /// Their open PnL.
    pub(crate) pnl: Figure,
    /// Their PnL as a percentage of their net investment.
    pub(crate) pnl_pct: PercentFigure,
}

impl From<views::OpenPositionsView> for OpenPositions {
    fn from(view: views::OpenPositionsView) -> Self {
        let totals = &view.totals;
        Self {
            items: view.items.iter().map(OpenPositionRow::from).collect(),
            next_cursor: None,
            freshness: view.freshness.into(),
            totals: OpenTotals {
                count: totals.count,
                out_of_range_count: totals.out_of_range_count,
                value: (&totals.value).into(),
                invested: (&totals.invested).into(),
                withdrawn: (&totals.withdrawn).into(),
                net_invested: (&totals.net_invested).into(),
                claimed_fees: (&totals.claimed_fees).into(),
                unclaimed_fees: (&totals.unclaimed_fees).into(),
                fees: (&totals.fees).into(),
                pnl: (&totals.pnl).into(),
                pnl_pct: (&totals.pnl_pct).into(),
            },
        }
    }
}

impl OpenSortQuery {
    /// The sort and direction of the engine.
    fn sort(self) -> (OpenSort, Option<SortOrder>) {
        let sort = match self.sort.unwrap_or_default() {
            SortKey::Range => OpenSort::Range,
            SortKey::Value => OpenSort::Value,
            SortKey::Pnl => OpenSort::Pnl,
            SortKey::Fees => OpenSort::Fees,
            SortKey::Unclaimed => OpenSort::Unclaimed,
            SortKey::Dpr => OpenSort::Dpr,
            SortKey::Age => OpenSort::Age,
            SortKey::Pair => OpenSort::Pair,
        };
        let order = self.order.map(SortOrder::from);
        (sort, order)
    }
}

/// Lists the open positions, sorted, with their totals.
#[utoipa::path(
    get,
    path = "/api/v1/positions/open",
    operation_id = "listOpenPositions",
    tag = "positions",
    security(("session_cookie" = [])),
    params(ScopeQuery, OpenSortQuery, CurrencyQuery),
    responses(
        (status = 200, description = "The open positions.", body = OpenPositions),
        (status = 400, description = "A query parameter is invalid (`invalid_request`).", body = ErrorBody),
        (status = 401, description = "Not signed in (`unauthenticated`).", body = ErrorBody),
        (status = 404, description = "The wallet is not tracked (`wallet_not_found`).", body = ErrorBody),
        (status = 503, description = "The engine does not serve figures yet (`data_not_ready`).", body = ErrorBody),
    ),
)]
pub(crate) async fn list_open_positions(
    State(state): State<AppState>,
    ApiQuery(scope): ApiQuery<ScopeQuery>,
    ApiQuery(sort): ApiQuery<OpenSortQuery>,
    ApiQuery(currency): ApiQuery<CurrencyQuery>,
) -> Result<Json<OpenPositions>, ApiError> {
    let (sort, order) = sort.sort();
    let request = OpenPositionsRequest {
        scope: scope.scope()?,
        sort,
        order,
        currency: currency.currency(),
    };
    let positions = state.engine.read_model().open_positions(request).await?;
    Ok(Json(positions.into()))
}
