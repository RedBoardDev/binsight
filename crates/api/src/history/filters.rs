//! The query string of a History list: its filters, its sort and its page, read into the engine's
//! query, and the fingerprint that ties a cursor to them.

use std::collections::BTreeSet;

use binsight_engine::portfolio::Scope;
use binsight_engine::portfolio::query::{ClosedQuery, ClosedSort, SearchText};
use binsight_ledger::facts::Strategy as LedgerStrategy;
use binsight_ledger::report::closed::Outcome as LedgerOutcome;
use binsight_ledger::report::valued;
use binsight_solana::Address;
use jiff::civil::Date;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use utoipa::ToSchema;

use crate::contract::{Order, Outcome, Strategy, comma_list};
use crate::error::{ApiError, ErrorCode};

/// The most pools one filter may name.
pub(crate) const MAX_FILTER_POOLS: usize = 20;

/// How many bytes of the filters' hash a cursor keeps.
const FINGERPRINT_BYTES: usize = 8;

/// The filters and the sort of a History list.
#[derive(Debug, Clone, Default, Deserialize, utoipa::IntoParams)]
#[into_params(parameter_in = Query)]
pub(crate) struct HistoryFilters {
    /// Only the positions closed on this local date (`YYYY-MM-DD`).
    pub(crate) day: Option<String>,
    /// A symbol (by prefix), a pair (`BONK/SOL`), a token name, or a mint, pool, position address
    /// or position id (by prefix, from 4 characters); 1 to 64 characters.
    pub(crate) search: Option<String>,
    /// Comma-separated outcomes: `win`, `loss`, `flat` (exactly even, or an empty shell),
    /// `unknown` (the sign is still open). Absent: every closed position.
    #[serde(default, deserialize_with = "comma_list")]
    #[param(value_type = Option<String>)]
    pub(crate) outcome: Vec<Outcome>,
    /// Comma-separated strategies: `spot`, `curve`, `bid_ask`. Absent: every strategy.
    #[serde(default, deserialize_with = "comma_list")]
    #[param(value_type = Option<String>)]
    pub(crate) strategy: Vec<Strategy>,
    /// Comma-separated pool addresses, at most 20 (from `listPools`). Absent: every pool.
    #[serde(default, deserialize_with = "comma_list")]
    #[param(value_type = Option<String>)]
    pub(crate) pool: Vec<String>,
    /// What to sort by (`closed_at` by default).
    #[param(inline)]
    pub(crate) sort: Option<ClosedSortParam>,
    /// The direction (`desc` by default).
    #[param(inline)]
    pub(crate) order: Option<Order>,
}

/// What closed positions are sorted by.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ClosedSortParam {
    /// When they closed (the only sort with day summaries).
    ClosedAt,
    /// How long they were held.
    Held,
    /// What they invested.
    Invested,
    /// What they withdrew.
    Withdrawn,
    /// The fees they claimed.
    Fees,
    /// Their PnL.
    Pnl,
    /// Their PnL as a percentage of what they invested.
    PnlPct,
    /// Their daily return.
    Dpr,
}

impl HistoryFilters {
    /// The engine's query for these filters, in `scope` and `currency`.
    ///
    /// # Errors
    ///
    /// Returns `400 invalid_request` naming the parameter that is not valid.
    pub(crate) fn query(
        &self,
        scope: Scope,
        currency: valued::Currency,
    ) -> Result<ClosedQuery, ApiError> {
        Ok(ClosedQuery {
            scope,
            day: self.day.as_deref().map(parse_day).transpose()?,
            search: self.search.as_deref().map(parse_search).transpose()?,
            outcomes: self
                .outcome
                .iter()
                .map(|outcome| LedgerOutcome::from(*outcome))
                .collect(),
            strategies: self
                .strategy
                .iter()
                .map(|strategy| LedgerStrategy::from(*strategy))
                .collect(),
            pools: parse_pools(&self.pool)?,
            sort: self.sort().into(),
            order: self.order().into(),
            currency,
        })
    }

    /// The sort asked for, `closed_at` by default.
    pub(crate) fn sort(&self) -> ClosedSortParam {
        self.sort.unwrap_or(ClosedSortParam::ClosedAt)
    }

    /// The direction asked for, `desc` by default.
    pub(crate) fn order(&self) -> Order {
        self.order.unwrap_or(Order::Desc)
    }
}

/// A short fingerprint of what a list filters on, so a cursor of another filter is refused.
#[derive(Serialize)]
struct CanonicalFilters {
    version: u8,
    scope: String,
    day: Option<String>,
    search: Option<String>,
    outcomes: Vec<&'static str>,
    strategies: Vec<&'static str>,
    pools: Vec<String>,
}

pub(crate) fn fingerprint(query: &ClosedQuery) -> Result<String, ApiError> {
    let scope = match query.scope {
        Scope::All => "all".to_owned(),
        Scope::Wallet(address) => format!("wallet:{address}"),
    };
    let mut outcomes: Vec<_> = query
        .outcomes
        .iter()
        .map(|outcome| Outcome::from(*outcome).name())
        .collect();
    let mut strategies: Vec<_> = query
        .strategies
        .iter()
        .map(|strategy| match strategy {
            LedgerStrategy::Spot => "spot",
            LedgerStrategy::Curve => "curve",
            LedgerStrategy::BidAsk => "bid_ask",
        })
        .collect();
    let mut pools: Vec<_> = query.pools.iter().map(ToString::to_string).collect();
    outcomes.sort_unstable();
    strategies.sort_unstable();
    pools.sort_unstable();
    let canonical = CanonicalFilters {
        version: 1,
        scope,
        day: query.day.map(|day| day.to_string()),
        search: query
            .search
            .as_ref()
            .map(|search| search.as_str().to_owned()),
        outcomes,
        strategies,
        pools,
    };
    let normalized = serde_json::to_vec(&canonical)
        .map_err(|error| ApiError::internal(format!("filter fingerprint: {error}")))?;
    Ok(Sha256::digest(normalized)
        .iter()
        .take(FINGERPRINT_BYTES)
        .flat_map(|byte| [byte >> 4, byte & 0x0f])
        .filter_map(|digit| char::from_digit(u32::from(digit), 16))
        .collect())
}

/// Reads a local date.
fn parse_day(text: &str) -> Result<Date, ApiError> {
    text.parse()
        .map_err(|_| ApiError::new(ErrorCode::InvalidRequest, "day: expected YYYY-MM-DD"))
}

/// Reads a search text.
fn parse_search(text: &str) -> Result<SearchText, ApiError> {
    SearchText::parse(text)
        .map_err(|error| ApiError::new(ErrorCode::InvalidRequest, format!("search: {error}")))
}

/// Reads at most [`MAX_FILTER_POOLS`] pool addresses.
fn parse_pools(texts: &[String]) -> Result<BTreeSet<Address>, ApiError> {
    if texts.len() > MAX_FILTER_POOLS {
        return Err(ApiError::new(
            ErrorCode::InvalidRequest,
            format!("pool: at most {MAX_FILTER_POOLS} pools"),
        ));
    }
    texts
        .iter()
        .map(|text| {
            text.parse().map_err(|_| {
                ApiError::new(
                    ErrorCode::InvalidRequest,
                    "pool: expected base58 pool addresses",
                )
            })
        })
        .collect()
}

impl From<ClosedSortParam> for ClosedSort {
    fn from(sort: ClosedSortParam) -> Self {
        match sort {
            ClosedSortParam::ClosedAt => Self::ClosedAt,
            ClosedSortParam::Held => Self::Held,
            ClosedSortParam::Invested => Self::Invested,
            ClosedSortParam::Withdrawn => Self::Withdrawn,
            ClosedSortParam::Fees => Self::Fees,
            ClosedSortParam::Pnl => Self::Pnl,
            ClosedSortParam::PnlPct => Self::PnlPct,
            ClosedSortParam::Dpr => Self::Dpr,
        }
    }
}
