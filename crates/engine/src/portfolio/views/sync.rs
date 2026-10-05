//! How far each wallet is synchronized, the chain tip and the credits of the billing cycle.

use binsight_core::ratio::Percent;
use binsight_ledger::report::figure::Figure;
use jiff::Timestamp;

use super::refs::WalletRef;
use crate::status::EngineStatus;

/// How a wallet (or the whole instance) keeps up with the chain, from the best to the worst.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum SyncState {
    /// Up to date.
    Live,
    /// Its history is being imported.
    Importing,
    /// Behind the chain, catching up.
    Lagging,
    /// Failing; a human should look.
    Error,
}

/// The synchronization of one wallet.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WalletSync {
    /// Its state.
    pub state: SyncState,
    /// How far behind the chain it is, in seconds, when known.
    pub lag_seconds: Option<u64>,
    /// When its last transaction happened.
    pub last_tx_at: Option<Timestamp>,
    /// How many of its transactions are indexed.
    pub indexed_tx: u64,
    /// How far the import of its history is, while it runs.
    pub import: Option<ImportProgress>,
}

/// The progress of a history import.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ImportProgress {
    /// How far it is.
    pub progress: Percent,
    /// How long it should still take, in seconds, when known.
    pub eta_seconds: Option<u64>,
}

/// A wallet and its synchronization.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WalletSyncLine {
    /// The wallet.
    pub wallet: WalletRef,
    /// Its synchronization.
    pub sync: WalletSync,
}

/// The last slot the instance saw.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct ChainTip {
    /// The slot.
    pub last_slot: Option<u64>,
    /// When it was seen.
    pub last_slot_at: Option<Timestamp>,
}

/// Exact UTC boundaries supplied by the credit governor, also simulated by the demo.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BillingCycle {
    /// The first instant charged to this cycle (inclusive).
    pub start: Timestamp,
    /// The first instant charged to the next cycle (exclusive).
    pub end: Timestamp,
}

/// The provider credits of the current billing cycle.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CreditsSummary {
    /// The governor's cycle boundaries.
    pub cycle: BillingCycle,
    /// Credits spent so far this cycle.
    pub used: u64,
    /// The cycle's credit budget.
    pub budget: u64,
    /// `used / budget`.
    pub used_percent: Figure<Percent>,
    /// Expected cycle spending at the current pace; unknown with no elapsed second.
    pub projected: Option<u64>,
    /// Observed or projected excess; unknown if neither proves a verdict yet.
    pub is_over_budget: Option<bool>,
}

/// The synchronization of the instance.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SyncReport {
    /// The worst state of the wallets (live when there is none).
    pub state: SyncState,
    /// Where the engine is in its lifecycle.
    pub engine: EngineStatus,
    /// When this report was made.
    pub as_of: Timestamp,
    /// When the engine started.
    pub started_at: Timestamp,
    /// The chain tip.
    pub chain: ChainTip,
    /// How often open positions are valued, in seconds, when they are.
    pub valuation_interval_seconds: Option<u64>,
    /// The credits of the billing cycle.
    pub credits: CreditsSummary,
    /// Each wallet, in the order of the wallet list.
    pub wallets: Vec<WalletSyncLine>,
}
