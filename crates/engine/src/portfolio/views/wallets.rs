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
    /// Its positions; `None` until the source counts positions.
    pub positions: Option<PositionCounts>,
}

/// The figures of every wallet together.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WalletsTotal {
    /// The total net worth.
    pub net_worth: Figure<Money>,
    /// The total real PnL.
    pub real_pnl: Figure<Money>,
    /// Every wallet's positions; `None` until the source counts positions.
    pub positions: Option<PositionCounts>,
}

/// How many positions are open, out of range and closed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PositionCounts {
    /// How many are open.
    pub open: usize,
    /// How many of the open ones are out of range.
    pub out_of_range: usize,
    /// How many were closed.
    pub closed: usize,
}
