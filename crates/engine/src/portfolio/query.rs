//! The queries: pure functions from a snapshot to a view.
//!
//! A source of figures only provides the snapshot (and the state of the instance); the queries
//! filter, sort and page it, and call the read rules of `binsight_ledger::report` for every
//! figure. They never read the clock (the instant is in the [`super::scope::ReadContext`]) and
//! never do I/O, so the demo world and the engine answer with the same semantics.

mod closed_rows;
mod history;
mod overview;
mod positions;
mod recent_closes;
mod refs;
mod scope_figures;
mod series;
mod sync;
mod wallets;
mod window;

pub use history::{
    ClosedPageRequest, ClosedQuery, ClosedSort, MAX_CLOSED_PAGE, MAX_POOL_OPTIONS,
    MAX_SEARCH_CHARS, PoolQuery, PoolSelection, SearchText, SearchTextError, closed_page, pools,
};
pub use overview::{OverviewRequest, overview};
pub use positions::{
    CandleRequest, EventPageRequest, IntervalChoice, MAX_CANDLES, MAX_EVENT_PAGE,
    OpenPositionsRequest, OpenSort, PositionRequest, SortOrder, candle_request, open_positions,
    position, position_events,
};
pub use recent_closes::recent_closes;
pub use refs::token_logo;
pub use series::{MAX_SERIES_BUCKETS, SeriesRequest, stats_series};
pub(crate) use sync::report_of;
pub use sync::sync_report;
pub use wallets::wallets;

use scope_figures::{check_scope, freshness};

pub(crate) use history::{compare_keys, key_of};
