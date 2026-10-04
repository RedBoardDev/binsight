//! How far each wallet is synchronized, the chain tip and the credits of the month.

use binsight_core::ratio::Percent;
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

/// The provider credits of the current month.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CreditsSummary {
    /// The year of the month.
    pub year: i16,
    /// The month, 1 to 12.
    pub month: i8,
    /// Credits spent so far this month.
    pub used: u64,
    /// The monthly budget.
    pub budget: u64,
    /// `used / budget`.
    pub used_percent: Percent,
    /// The credits the month will have spent at the current pace.
    pub projected: u64,
    /// Whether the projection exceeds the budget.
    pub is_over_budget: bool,
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
    /// The credits of the month.
    pub credits: CreditsSummary,
    /// Each wallet, in the order of the wallet list.
    pub wallets: Vec<WalletSyncLine>,
}
