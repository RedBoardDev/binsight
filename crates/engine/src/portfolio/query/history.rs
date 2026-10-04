//! The queries of History: pages of closed positions under multi-choice filters, sorted by the
//! server and read after a key, and the pools of the history for the pool filter. There is no
//! period: the infinite list covers time, and a local day narrows it when asked.

mod filter;
mod key;
mod page;
mod pools;
mod search;

pub use filter::{ClosedQuery, ClosedSort};
pub use page::{ClosedPageRequest, MAX_CLOSED_PAGE, closed_page};
pub use pools::{MAX_POOL_OPTIONS, PoolQuery, PoolSelection, pools};
pub use search::{MAX_SEARCH_CHARS, SearchText, SearchTextError};
