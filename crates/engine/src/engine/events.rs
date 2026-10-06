//! The domain events the engine publishes to anyone listening (the live event stream of the API,
//! later the notifications).
//!
//! Events describe what happened, in domain terms; how they travel over the wire is the API's
//! business. This module only defines them.

use binsight_solana::Address;

use crate::engine::status::EngineStatus;
use crate::ingestion::SyncState;

/// Something the engine wants the rest of the application to know.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EngineEvent {
    /// The engine moved to a new lifecycle status.
    StatusChanged {
        /// The new status.
        status: EngineStatus,
    },
    /// A wallet's sync state changed.
    WalletSyncChanged {
        /// The wallet.
        wallet: Address,
        /// Its new state.
        state: SyncState,
    },
}
