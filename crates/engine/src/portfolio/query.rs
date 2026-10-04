//! The queries: pure functions from a snapshot to a view.
//!
//! A source of figures only provides the snapshot (and the state of the instance); the queries
//! filter, sort and page it, and call the read rules of `binsight_ledger::report` for every
//! figure. They never read the clock (the instant is in the [`super::scope::ReadContext`]) and
//! never do I/O, so the demo world and the engine answer with the same semantics.

mod bin_chart;
mod closed_rows;
mod open_positions;
mod overview;
mod recent_closes;
mod refs;
mod scope_figures;
mod series;
mod sort;
mod sync;
mod wallets;
mod window;

pub use open_positions::{OpenPositionsRequest, open_positions};
pub use overview::{OverviewRequest, overview};
pub use recent_closes::recent_closes;
pub use refs::token_logo;
pub use series::{MAX_SERIES_BUCKETS, SeriesRequest, stats_series};
pub use sort::{OpenSort, SortOrder};
pub use sync::sync_report;
pub use wallets::wallets;

use scope_figures::{check_scope, freshness};
