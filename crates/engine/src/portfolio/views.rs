//! What a read of the portfolio answers: plain values the API turns into its wire types.
//!
//! Views hold figures already resolved in the currency the read asked for (with their exactness
//! and reasons), counts and references to wallets, pools and tokens. They hold no rule: every
//! figure comes from `binsight_ledger::report`, applied by the queries.

mod closed;
mod history;
mod logo;
mod overview;
mod position;
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
pub use history::{ClosedKey, ClosedPage, DayGroup, PoolOption};
pub use logo::TokenLogoImage;
pub use overview::{
    GainView, NetWorthView, OpenSummary, OverviewSync, OverviewView, TodayView, UnpricedHolding,
    WatchItem,
};
pub use position::{
    BinBar, BinChart, CANDLE_INTERVALS, CandleInterval, CandleSource, CandleStatus, CandleView,
    CandlesUnavailable, CandlesView, ChartMarker, ChartView, EventPage, MAX_BIN_BARS, MovementKind,
    OpenPositionRow, OpenPositionsView, OpenTotals, PositionDetailView, PositionEventView,
    PositionState, RangeBounds, RangeSpan, RangeView, RewardMovement, TokenQuantity,
};
pub use refs::{PoolRef, PriceView, TokenLogo, TokenRef, WalletColor, WalletRef};
pub use series::{SeriesHeaderView, SeriesPointView, SeriesView};
pub use settings::{InstanceSettings, TimezoneSource};
pub use sync::{
    BillingCycle, ChainTip, CreditsSummary, ImportProgress, SyncReport, SyncState, WalletSync,
    WalletSyncLine,
};
pub use wallets::{PositionCounts, WalletSummary, WalletsTotal, WalletsView};
pub use window::{Freshness, WindowView};
