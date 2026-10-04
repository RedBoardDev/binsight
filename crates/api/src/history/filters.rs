//! The query string of a History list: its filters, its sort and its page, read into the engine's
//! query, and the fingerprint that ties a cursor to them.

use std::collections::BTreeSet;

use binsight_engine::portfolio::Scope;
use binsight_engine::portfolio::query::{ClosedQuery, ClosedSort, SearchText};
use binsight_ledger::facts::Strategy as LedgerStrategy;
use binsight_ledger::report::history_outcome::HistoryOutcome;
use binsight_ledger::report::valued;
use binsight_solana::Address;
use jiff::civil::Date;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use utoipa::ToSchema;

use crate::contract::{Order, Strategy, comma_list};
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
    /// Comma-separated outcomes: `win`, `loss`, `flat` (a PnL under 0.01 SOL either way, or an
    /// empty shell). Absent: every outcome.
    #[serde(default, deserialize_with = "comma_list")]
    #[param(value_type = Option<String>)]
    pub(crate) outcome: Vec<HistoryOutcomeParam>,
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

/// How History files a closed position for its outcome filter.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub(crate) enum HistoryOutcomeParam {
    /// It gained 0.01 SOL or more.
    Win,
    /// It lost 0.01 SOL or more.
    Loss,
    /// It moved less than 0.01 SOL either way, or never moved.
    Flat,
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
                .map(|outcome| (*outcome).into())
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
pub(crate) fn fingerprint(query: &ClosedQuery) -> String {
    let scope = match query.scope {
        Scope::All => "all".to_owned(),
        Scope::Wallet(address) => address.to_string(),
    };
    let normalized = format!(
        "{scope}|{:?}|{:?}|{:?}|{:?}|{:?}",
        query.day,
        query.search.as_ref().map(SearchText::as_str),
        query.outcomes,
        query.strategies,
        query.pools,
    );
    Sha256::digest(normalized.as_bytes())
        .iter()
        .take(FINGERPRINT_BYTES)
        .flat_map(|byte| [byte >> 4, byte & 0x0f])
        .filter_map(|digit| char::from_digit(u32::from(digit), 16))
        .collect()
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

impl From<HistoryOutcomeParam> for HistoryOutcome {
    fn from(outcome: HistoryOutcomeParam) -> Self {
        match outcome {
            HistoryOutcomeParam::Win => Self::Win,
            HistoryOutcomeParam::Loss => Self::Loss,
            HistoryOutcomeParam::Flat => Self::Flat,
        }
    }
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
