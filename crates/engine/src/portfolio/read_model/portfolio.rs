//! Reads about the portfolio as a whole: the overview, the open positions and the recent closes.

use binsight_ledger::report::valued::Currency;

use crate::portfolio::answer::Answer;
use crate::portfolio::query::{OpenPositionsRequest, OverviewRequest};
use crate::portfolio::scope::Scope;
use crate::portfolio::views::{OpenPositionsView, OverviewView, RecentClosesView};

/// What the API reads about the portfolio as a whole.
pub trait PortfolioReads: Send + Sync {
    /// The overview of a scope over a period.
    fn overview(&self, request: OverviewRequest) -> Answer<'_, OverviewView>;

    /// The open positions of a scope, sorted.
    fn open_positions(&self, request: OpenPositionsRequest) -> Answer<'_, OpenPositionsView>;

    /// The positions of a scope closed today and yesterday.
    fn recent_closes(&self, scope: Scope, currency: Currency) -> Answer<'_, RecentClosesView>;
}
