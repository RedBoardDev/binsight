//! What a History list asks for, and whether a closed position belongs to it.

use std::collections::BTreeSet;

use binsight_ledger::facts::Strategy;
use binsight_ledger::report::history_outcome::HistoryOutcome;
use binsight_ledger::report::period::Window;
use binsight_ledger::report::valued::Currency;
use binsight_solana::Address;
use jiff::civil::Date;

use super::search::SearchText;
use crate::portfolio::query::SortOrder;
use crate::portfolio::scope::Scope;
use crate::portfolio::snapshot::{ClosedRow, Snapshot};

/// What a History list asks for. An empty set of choices means no filter on it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClosedQuery {
    /// Whose positions.
    pub scope: Scope,
    /// Only the positions closed on this local day, when set.
    pub day: Option<Date>,
    /// Only the positions the text names, when set.
    pub search: Option<SearchText>,
    /// Only these outcomes.
    pub outcomes: BTreeSet<HistoryOutcome>,
    /// Only these strategies.
    pub strategies: BTreeSet<Strategy>,
    /// Only these pools.
    pub pools: BTreeSet<Address>,
    /// How to sort them.
    pub sort: ClosedSort,
    /// In which direction.
    pub order: SortOrder,
    /// The currency of the figures, which also decides the order of amounts.
    pub currency: Currency,
}

/// What closed positions are sorted by.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ClosedSort {
    /// When they closed.
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

impl ClosedQuery {
    /// Whether `row` belongs to the list (its scope and closing time are checked by the caller).
    pub(super) fn matches(
        &self,
        snapshot: &Snapshot,
        row: &ClosedRow,
        day: Option<&Window>,
    ) -> bool {
        let facts = &row.facts;
        let in_day = day.is_none_or(|window| window.contains(facts.closed_at));
        let in_outcomes =
            self.outcomes.is_empty() || self.outcomes.contains(&HistoryOutcome::of(&row.valuation));
        let in_strategies = self.strategies.is_empty() || self.strategies.contains(&facts.strategy);
        let in_pools = self.pools.is_empty() || self.pools.contains(&facts.pool);
        let in_search = self.search.as_ref().is_none_or(|search| {
            snapshot
                .pool(facts.pool)
                .is_some_and(|pool| search.matches_position(facts.id, pool))
        });
        in_day && in_outcomes && in_strategies && in_pools && in_search
    }
}
