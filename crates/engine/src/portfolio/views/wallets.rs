//! The tracked wallets with their figures.

use binsight_core::ratio::Percent;
use binsight_ledger::report::figure::Figure;
use binsight_ledger::report::valued::Money;
use jiff::Timestamp;

use super::refs::WalletRef;
use super::sync::WalletSync;

/// The tracked wallets and their total.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WalletsView {
    /// Each wallet, in the order they were added.
    pub items: Vec<WalletSummary>,
    /// The figures of every wallet together.
    pub total: WalletsTotal,
}

/// One tracked wallet and its figures.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WalletSummary {
    /// The wallet.
    pub wallet: WalletRef,
    /// When the owner added it.
    pub added_at: Timestamp,
    /// Its synchronization.
    pub sync: WalletSync,
    /// Its net worth now.
    pub net_worth: Figure<Money>,
    /// Its real PnL since its first activity.
    pub real_pnl: Figure<Money>,
    /// Its net worth as a share of the total net worth.
    pub share_of_net_worth: Figure<Percent>,
    /// How many positions it has open.
    pub open_count: usize,
    /// How many of them are out of range.
    pub out_of_range_count: usize,
    /// How many positions it closed.
    pub closed_count: usize,
}

/// The figures of every wallet together.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WalletsTotal {
    /// The total net worth.
    pub net_worth: Figure<Money>,
    /// The total real PnL.
    pub real_pnl: Figure<Money>,
    /// How many positions are open.
    pub open_count: usize,
    /// How many of them are out of range.
    pub out_of_range_count: usize,
    /// How many positions were closed.
    pub closed_count: usize,
}
