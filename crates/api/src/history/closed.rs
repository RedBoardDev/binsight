//! `GET /api/v1/positions/closed`: History, an infinite list of closed positions under
//! multi-choice filters, sorted by the server, a page at a time.
//!
//! The first page fixes the instant of the list (`as_of`); its cursor carries it with the sort,
//! the currency and a fingerprint of the filters, so the next pages leave out later closes and a
//! cursor of another query is refused (`invalid_cursor`). A new close reaches the list when the
//! client reloads it from the first page.

use axum::Json;
use axum::extract::State;
use binsight_engine::portfolio::query::{ClosedPageRequest, MAX_CLOSED_PAGE};
use binsight_engine::portfolio::views;
use binsight_ledger::facts::PositionId;
use jiff::Timestamp;
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use super::filters::{ClosedSortParam, HistoryFilters, fingerprint};
use crate::app::AppState;
use crate::contract::{
    ApiQuery, ClosedPositionRow, Currency, CurrencyQuery, Figure, Order, PercentFigure, ScopeQuery,
    decode_cursor, encode_cursor, foreign_cursor,
};
use crate::error::{ApiError, ErrorBody, ErrorCode};

/// The positions a page holds unless asked otherwise.
const DEFAULT_LIMIT: usize = 50;

/// Which page.
#[derive(Debug, Clone, Default, Deserialize, utoipa::IntoParams)]
#[into_params(parameter_in = Query)]
pub(crate) struct PageQuery {
    /// The `next_cursor` of the previous page, with the same filters; absent for the first page.
    pub(crate) cursor: Option<String>,
    /// How many positions at most (50 by default, 200 at most).
    pub(crate) limit: Option<usize>,
}

/// A page of History.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ToSchema)]
pub(crate) struct ClosedPositionPage {
    /// The positions, sorted as asked.
    pub(crate) items: Vec<ClosedPositionRow>,
    /// The cursor of the next page; `null` on the last one.
    pub(crate) next_cursor: Option<String>,
    /// The instant the list is read at, fixed by its first page: later closes are left out.
    pub(crate) as_of: Timestamp,
    /// How many positions match the filters at that instant, over every page.
    pub(crate) matched_count: usize,
    /// How many positions of the wallet filter closed by that instant, whatever the other
    /// filters (`matched_count / total_count` in the title).
    pub(crate) total_count: usize,
    /// The summary of each local day the page touches, over the whole filtered list; a day cut
    /// by two pages comes twice with the same figures. `null` unless sorted by `closed_at`.
    pub(crate) day_groups: Option<Vec<DayGroup>>,
}

/// The summary of the filtered positions closed on one local day (shells left out).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ToSchema)]
pub(crate) struct DayGroup {
    /// The local date, `YYYY-MM-DD`.
    pub(crate) day: String,
    /// How many closed.
    pub(crate) count: usize,
    /// How many gained.
    pub(crate) wins: usize,
    /// How many lost.
    pub(crate) losses: usize,
    /// How many ended exactly even.
    pub(crate) breakeven: usize,
    /// `wins / (wins + losses)`.
    pub(crate) win_rate: PercentFigure,
    /// The sum of their PnL.
    pub(crate) pnl: Figure,
}

/// What a History cursor holds: the instant of the list, the query it was written for, and the
/// key of the last position read.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct ClosedCursor {
    as_of: Timestamp,
    query: CursorQuery,
    after_value: Option<String>,
    after_id: String,
}

/// What a cursor must match: the sort, the currency (it decides the order of amounts) and the
/// filters.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct CursorQuery {
    sort: ClosedSortParam,
    order: Order,
    currency: Currency,
    filters: String,
}

impl ClosedCursor {
    /// The cursor after `key`, in the list of `query` read at `as_of`.
    fn after(as_of: Timestamp, query: CursorQuery, key: views::ClosedKey) -> Self {
        Self {
            as_of,
            query,
            after_value: key.value.map(|value| value.to_string()),
            after_id: key.id.to_string(),
        }
    }

    /// The key it holds, if it was written for `query`.
    fn key_for(&self, query: &CursorQuery) -> Result<views::ClosedKey, ApiError> {
        if self.query != *query {
            return Err(foreign_cursor());
        }
        let value = match &self.after_value {
            Some(text) => Some(text.parse::<i128>().map_err(|_| foreign_cursor())?),
            None => None,
        };
        let id: PositionId = self.after_id.parse().map_err(|_| foreign_cursor())?;
        Ok(views::ClosedKey { value, id })
    }
}

impl From<&views::DayGroup> for DayGroup {
    fn from(group: &views::DayGroup) -> Self {
        Self {
            day: group.day.to_string(),
            count: group.count,
            wins: group.wins,
            losses: group.losses,
            breakeven: group.breakeven,
            win_rate: (&group.win_rate).into(),
            pnl: (&group.pnl).into(),
        }
    }
}

/// Lists closed positions, a page at a time.
#[utoipa::path(
    get,
    path = "/api/v1/positions/closed",
    operation_id = "listClosedPositions",
    tag = "history",
    security(("session_cookie" = [])),
    params(ScopeQuery, HistoryFilters, PageQuery, CurrencyQuery),
    responses(
        (status = 200, description = "A page of closed positions.", body = ClosedPositionPage),
        (status = 400, description = "A query parameter is invalid (`invalid_request`), or the cursor belongs to another query (`invalid_cursor`: start again from the first page).", body = ErrorBody),
        (status = 401, description = "Not signed in (`unauthenticated`).", body = ErrorBody),
        (status = 404, description = "The wallet is not tracked (`wallet_not_found`).", body = ErrorBody),
        (status = 503, description = "The engine does not serve figures yet (`data_not_ready`).", body = ErrorBody),
    ),
)]
pub(crate) async fn list_closed_positions(
    State(state): State<AppState>,
    ApiQuery(scope): ApiQuery<ScopeQuery>,
    ApiQuery(filters): ApiQuery<HistoryFilters>,
    ApiQuery(page): ApiQuery<PageQuery>,
    ApiQuery(currency): ApiQuery<CurrencyQuery>,
) -> Result<Json<ClosedPositionPage>, ApiError> {
    let currency_param = currency.currency.unwrap_or_default();
    let query = filters.query(scope.scope()?, currency_param.into())?;
    let limit = page.limit.unwrap_or(DEFAULT_LIMIT);
    if !(1..=MAX_CLOSED_PAGE).contains(&limit) {
        return Err(ApiError::new(
            ErrorCode::InvalidRequest,
            format!("limit: expected 1 to {MAX_CLOSED_PAGE}"),
        ));
    }
    let cursor_query = CursorQuery {
        sort: filters.sort(),
        order: filters.order(),
        currency: currency_param,
        filters: fingerprint(&query),
    };
    let (as_of, after) = match page.cursor.as_deref() {
        Some(text) => {
            let cursor: ClosedCursor = decode_cursor(text)?;
            (Some(cursor.as_of), Some(cursor.key_for(&cursor_query)?))
        }
        None => (None, None),
    };
    let request = ClosedPageRequest {
        as_of,
        after,
        limit,
    };
    let page = state
        .engine
        .read_model()
        .closed_page(query, request)
        .await?;
    let next_cursor = page
        .next
        .map(|key| encode_cursor(ClosedCursor::after(page.as_of, cursor_query, key)));
    Ok(Json(ClosedPositionPage {
        items: page.items.iter().map(ClosedPositionRow::from).collect(),
        next_cursor,
        as_of: page.as_of,
        matched_count: page.matched_count,
        total_count: page.total_count,
        day_groups: page
            .day_groups
            .as_ref()
            .map(|groups| groups.iter().map(DayGroup::from).collect()),
    }))
}
