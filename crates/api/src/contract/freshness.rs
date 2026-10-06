//! How a wallet keeps up with the chain, and how fresh a screen's figures are.

use binsight_engine::portfolio::views;
use jiff::Timestamp;
use serde::Serialize;
use utoipa::ToSchema;

/// How a wallet (or the instance) keeps up with the chain, from the best to the worst.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub(crate) enum SyncState {
    /// Up to date.
    Live,
    /// Its history is being imported.
    Importing,
    /// Behind the chain, catching up.
    Lagging,
    /// Failing; the owner should look.
    Error,
}

/// How fresh a screen's figures are. Freshness never changes a figure's exactness: a lagging
/// wallet's figures stay exact, only older.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ToSchema)]
pub(crate) struct Freshness {
    /// When the figures were read.
    pub(crate) as_of: Timestamp,
    /// The worst sync state of the wallets they cover.
    pub(crate) state: SyncState,
    /// The largest lag of those wallets, in seconds, when known.
    pub(crate) lag_seconds: Option<u64>,
}

impl From<views::SyncState> for SyncState {
    fn from(state: views::SyncState) -> Self {
        match state {
            views::SyncState::Live => Self::Live,
            views::SyncState::Importing => Self::Importing,
            views::SyncState::Lagging => Self::Lagging,
            views::SyncState::Error => Self::Error,
        }
    }
}

impl From<views::Freshness> for Freshness {
    fn from(freshness: views::Freshness) -> Self {
        Self {
            as_of: freshness.as_of,
            state: freshness.state.into(),
            lag_seconds: freshness.lag_seconds,
        }
    }
}
