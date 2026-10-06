//! The wire form of what the startup check of the registry found.

use binsight_engine::portfolio::views;
use jiff::Timestamp;
use serde::Serialize;
use utoipa::ToSchema;

/// What the startup check of the registry found, before any work started. It reads the database
/// only and spends no credit.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ToSchema)]
pub(crate) struct RegistryCheck {
    /// When it ran.
    pub(crate) checked_at: Timestamp,
    /// What it found, one entry per kind; empty when every fact of the registry agrees.
    pub(crate) findings: Vec<RegistryFinding>,
}

/// One kind of disagreement the check found, and how many.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ToSchema)]
pub(crate) struct RegistryFinding {
    /// What disagrees, and what was done about it.
    pub(crate) kind: RegistryFindingKind,
    /// How many wallets (`wrong_listed_counts`, `unlisted_cursor_points`) or transactions (every
    /// other kind).
    pub(crate) count: u64,
}

/// What the startup check can find, and what was done about it:
/// `wrong_listed_counts`, wallets counted again; `unlisted_cursor_points`, wallets whose cursor
/// names a signature they do not list, repaired in full through the credit budget;
/// `unqueued_signatures`, listed signatures without a fetch task, queued; `fetched_without_payload`,
/// transactions marked fetched but missing from the registry, fetched again; `stored_but_queued`,
/// stored transactions still queued, marked fetched; `unreturned_transactions`, listed
/// transactions the node has not returned yet, tried again; `outdated_decodes`, transactions
/// decoded again at the current versions; `unordered_transactions`, transactions whose payload
/// holds no index in its block, which cannot be ordered exactly.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub(crate) enum RegistryFindingKind {
    /// Wallets whose counter of listed signatures was wrong.
    WrongListedCounts,
    /// Wallets whose cursor or verified repair point names a signature they do not list.
    UnlistedCursorPoints,
    /// Listed signatures without a fetch task.
    UnqueuedSignatures,
    /// Transactions marked fetched but missing from the registry.
    FetchedWithoutPayload,
    /// Transactions in the registry whose fetch was still queued.
    StoredButQueued,
    /// Listed transactions the node has not returned yet.
    UnreturnedTransactions,
    /// Transactions without a decoding result at the current versions.
    OutdatedDecodes,
    /// Transactions whose payload holds no index in its block.
    UnorderedTransactions,
}

impl From<&views::RegistryCheck> for RegistryCheck {
    fn from(check: &views::RegistryCheck) -> Self {
        Self {
            checked_at: check.checked_at,
            findings: check
                .findings
                .iter()
                .map(|finding| RegistryFinding {
                    kind: finding.kind.into(),
                    count: finding.count,
                })
                .collect(),
        }
    }
}

impl From<views::RegistryFindingKind> for RegistryFindingKind {
    fn from(kind: views::RegistryFindingKind) -> Self {
        match kind {
            views::RegistryFindingKind::WrongListedCounts => Self::WrongListedCounts,
            views::RegistryFindingKind::UnlistedCursorPoints => Self::UnlistedCursorPoints,
            views::RegistryFindingKind::UnqueuedSignatures => Self::UnqueuedSignatures,
            views::RegistryFindingKind::FetchedWithoutPayload => Self::FetchedWithoutPayload,
            views::RegistryFindingKind::StoredButQueued => Self::StoredButQueued,
            views::RegistryFindingKind::UnreturnedTransactions => Self::UnreturnedTransactions,
            views::RegistryFindingKind::OutdatedDecodes => Self::OutdatedDecodes,
            views::RegistryFindingKind::UnorderedTransactions => Self::UnorderedTransactions,
        }
    }
}
