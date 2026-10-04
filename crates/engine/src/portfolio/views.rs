//! What a read of the portfolio answers: plain values the API turns into its wire types.
//!
//! Views hold figures already resolved in the currency the read asked for (with their exactness
//! and reasons), counts and references to wallets, pools and tokens. They hold no rule: every
//! figure comes from `binsight_ledger::report`, applied by the queries.

mod closed;
mod logo;
mod open_positions;
mod overview;
mod refs;
mod series;
mod settings;
mod sync;
mod wallets;
mod window;

pub use closed::{
    ClosedDay, ClosedPositionRow, ClosedTotalsView, PnlMethodView, RECENT_CLOSES_PER_DAY,
    RecentClosesView,
};
pub use logo::TokenLogoImage;
pub use open_positions::{
    BinBar, BinChart, MAX_BIN_BARS, OpenPositionRow, OpenPositionsView, OpenTotals, RangeView,
};
pub use overview::{
    GainView, NetWorthView, OpenSummary, OverviewSync, OverviewView, TodayView, UnpricedHolding,
    WatchItem,
};
pub use refs::{PoolRef, PriceView, TokenLogo, TokenRef, WalletColor, WalletRef};
pub use series::{SeriesHeaderView, SeriesPointView, SeriesView};
pub use settings::{InstanceSettings, TimezoneSource};
pub use sync::{
    ChainTip, CreditsSummary, ImportProgress, SyncReport, SyncState, WalletSync, WalletSyncLine,
};
pub use wallets::{WalletSummary, WalletsTotal, WalletsView};
pub use window::{Freshness, WindowView};
