//! Reads of History: pages of closed positions and the pools of the history.

use crate::portfolio::answer::Answer;
use crate::portfolio::query::{ClosedPageRequest, ClosedQuery, PoolQuery};
use crate::portfolio::views::{ClosedPage, PoolOption};

/// What the API reads for History.
pub trait HistoryReads: Send + Sync {
    /// A page of the closed positions `query` asks for.
    fn closed_page(&self, query: ClosedQuery, page: ClosedPageRequest) -> Answer<'_, ClosedPage>;

    /// The pools of the history `query` asks for.
    fn pools(&self, query: PoolQuery) -> Answer<'_, Vec<PoolOption>>;
}
