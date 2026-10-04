//! A time window as the screens show it, and how fresh the figures are.

use binsight_ledger::report::period::WindowScope;
use jiff::Timestamp;

use super::sync::SyncState;

/// The span of time figures cover.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WindowView {
    /// What it was asked for: a period or a local day.
    pub scope: WindowScope,
    /// Its first instant.
    pub start: Timestamp,
    /// The instant right after it (now for a window that is not over).
    pub end: Timestamp,
    /// The IANA time zone its days are cut in.
    pub timezone: String,
}

/// How fresh the figures of a scope are; freshness never changes their exactness.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Freshness {
    /// When they were read.
    pub as_of: Timestamp,
    /// The worst sync state of the wallets of the scope.
    pub state: SyncState,
    /// The largest lag of the wallets of the scope, in seconds, when known.
    pub lag_seconds: Option<u64>,
}
