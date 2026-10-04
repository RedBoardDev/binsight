//! `GET /api/v1/pools`: the pools of the owner's history, for History's pool filter, searched by
//! pair, token or address, or named by address to label the pools a filter already holds.

use std::collections::BTreeSet;

use axum::Json;
use axum::extract::State;
use binsight_engine::portfolio::query::{MAX_POOL_OPTIONS, PoolQuery, PoolSelection, SearchText};
use binsight_engine::portfolio::views;
use jiff::Timestamp;
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use super::filters::MAX_FILTER_POOLS;
use crate::app::AppState;
use crate::contract::{ApiQuery, PoolRef, ScopeQuery, comma_list};
use crate::error::{ApiError, ErrorBody, ErrorCode};

/// The pools a read lists unless asked otherwise.
const DEFAULT_LIMIT: usize = 20;

/// Which pools.
#[derive(Debug, Clone, Default, Deserialize, utoipa::IntoParams)]
#[into_params(parameter_in = Query)]
pub(crate) struct PoolsQuery {
    /// A symbol (by prefix), a pair (`BONK/SOL`), a token name, or a mint or pool address (by
    /// prefix, from 4 characters); 1 to 64 characters. Exact symbols come first.
    pub(crate) search: Option<String>,
    /// Comma-separated pool addresses, at most 20: names the pools a filter already holds. Not
    /// with `search`.
    #[serde(default, deserialize_with = "comma_list")]
    #[param(value_type = Option<String>)]
    pub(crate) address: Vec<String>,
    /// How many pools at most (20 by default, 50 at most).
    pub(crate) limit: Option<usize>,
}

/// Pools of the history.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ToSchema)]
pub(crate) struct PoolOptions {
    /// The pools: exact symbol matches first, then the latest close first.
    pub(crate) items: Vec<PoolOption>,
    /// Always `null`: the list is never paged.
    pub(crate) next_cursor: Option<String>,
}

/// A pool of the history.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ToSchema)]
pub(crate) struct PoolOption {
    /// The pool (two pools of one pair differ by `bin_step`).
    pub(crate) pool: PoolRef,
    /// How many of its positions closed: what History lists for this pool alone.
    pub(crate) closed_count: usize,
    /// How many of its positions are open.
    pub(crate) open_count: usize,
    /// When its latest position closed; `null` when none did.
    pub(crate) last_closed_at: Option<Timestamp>,
}

impl PoolsQuery {
    /// Which pools the query names.
    fn selection(&self) -> Result<PoolSelection, ApiError> {
        let invalid = |message: &str| ApiError::new(ErrorCode::InvalidRequest, message.to_owned());
        match (self.search.as_deref(), self.address.is_empty()) {
            (Some(_), false) => Err(invalid("search and address cannot be used together")),
            (Some(text), true) => SearchText::parse(text)
                .map(PoolSelection::Search)
                .map_err(|error| invalid(&format!("search: {error}"))),
            (None, false) if self.address.len() > MAX_FILTER_POOLS => {
                Err(invalid("address: at most 20 pools"))
            }
            (None, false) => self
                .address
                .iter()
                .map(|text| {
                    text.parse()
                        .map_err(|_| invalid("address: expected base58 pool addresses"))
                })
                .collect::<Result<BTreeSet<_>, _>>()
                .map(PoolSelection::Addresses),
            (None, true) => Ok(PoolSelection::All),
        }
    }
}

impl From<&views::PoolOption> for PoolOption {
    fn from(option: &views::PoolOption) -> Self {
        Self {
            pool: (&option.pool).into(),
            closed_count: option.closed_count,
            open_count: option.open_count,
            last_closed_at: option.last_closed_at,
        }
    }
}

/// Lists the pools of the history.
#[utoipa::path(
    get,
    path = "/api/v1/pools",
    operation_id = "listPools",
    tag = "history",
    security(("session_cookie" = [])),
    params(ScopeQuery, PoolsQuery),
    responses(
        (status = 200, description = "The pools.", body = PoolOptions),
        (status = 400, description = "A query parameter is invalid (`invalid_request`).", body = ErrorBody),
        (status = 401, description = "Not signed in (`unauthenticated`).", body = ErrorBody),
        (status = 404, description = "The wallet is not tracked (`wallet_not_found`).", body = ErrorBody),
        (status = 503, description = "The engine does not serve figures yet (`data_not_ready`).", body = ErrorBody),
    ),
)]
pub(crate) async fn list_pools(
    State(state): State<AppState>,
    ApiQuery(scope): ApiQuery<ScopeQuery>,
    ApiQuery(query): ApiQuery<PoolsQuery>,
) -> Result<Json<PoolOptions>, ApiError> {
    let limit = query.limit.unwrap_or(DEFAULT_LIMIT);
    if !(1..=MAX_POOL_OPTIONS).contains(&limit) {
        return Err(ApiError::new(
            ErrorCode::InvalidRequest,
            format!("limit: expected 1 to {MAX_POOL_OPTIONS}"),
        ));
    }
    let request = PoolQuery {
        scope: scope.scope()?,
        selection: query.selection()?,
        limit,
    };
    let pools = state.engine.read_model().pools(request).await?;
    Ok(Json(PoolOptions {
        items: pools.iter().map(PoolOption::from).collect(),
        next_cursor: None,
    }))
}
