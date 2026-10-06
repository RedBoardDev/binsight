//! What the startup check of the registry found, and what was done about it.

use jiff::Timestamp;

/// What the startup check of the registry found, before any worker started.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RegistryCheck {
    /// When it ran.
    pub checked_at: Timestamp,
    /// What it found, one entry per kind; empty when every fact of the registry agrees.
    pub findings: Vec<RegistryFinding>,
}

/// One kind of disagreement the check found, and how many.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RegistryFinding {
    /// What disagrees, and what was done about it.
    pub kind: RegistryFindingKind,
    /// How many wallets or transactions (the kind says which).
    pub count: u64,
}

/// What the startup check can find. Each kind says what was done about it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum RegistryFindingKind {
    /// Wallets whose counter of listed signatures was wrong: they were counted again.
    WrongListedCounts,
    /// Wallets whose cursor or verified repair point names a signature they do not list: their
    /// listing is repaired in full, through the credit budget.
    UnlistedCursorPoints,
    /// Listed signatures without a fetch task: they were queued, or marked fetched when the
    /// registry already held their transaction.
    UnqueuedSignatures,
    /// Tasks marked fetched whose transaction is not in the registry: they were queued again.
    FetchedWithoutPayload,
    /// Transactions in the registry whose task was still open: marked fetched, never fetched
    /// again.
    StoredButQueued,
    /// Listed transactions the node has not returned yet: still tried on their schedule, and at
    /// once when a repair lists them.
    UnreturnedTransactions,
    /// Transactions without a decoding result at the current reader and decoder versions: the
    /// decoder reads them again, from the registry.
    OutdatedDecodes,
    /// Decoded transactions whose payload holds no index in its block: they cannot be ordered
    /// exactly, and nothing can fix that, since a payload is never fetched again.
    UnorderedTransactions,
}

impl RegistryCheck {
    /// Whether every fact of the registry agreed.
    pub fn is_consistent(&self) -> bool {
        self.findings.is_empty()
    }
}
