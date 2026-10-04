//! What a read of the portfolio answers: plain values the API turns into its wire types.
//!
//! Views hold figures already resolved in the currency the read asked for (with their exactness
//! and reasons), counts and references to wallets, pools and tokens. They hold no rule: every
//! figure comes from `binsight_ledger::report`, applied by the queries.

mod refs;
mod settings;
mod sync;
mod wallets;

pub use refs::{WalletColor, WalletRef};
pub use settings::{InstanceSettings, TimezoneSource};
pub use sync::{
    ChainTip, CreditsSummary, ImportProgress, SyncReport, SyncState, WalletSync, WalletSyncLine,
};
pub use wallets::{WalletSummary, WalletsTotal, WalletsView};
