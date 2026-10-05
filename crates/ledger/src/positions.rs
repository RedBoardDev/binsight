//! Replay proved position lifetimes and ownership before booking each wallet transaction.
//!
//! Sources retain the raw transaction, original activity and explicit ordering provenance.
//! This module neither values amounts nor reads storage, the network or a clock. Missing
//! creation or dates remain visible diagnostics; no position identity is reconstructed.

mod diagnostic;
mod lifetime;
mod normalization;
mod ownership;
mod replay;
mod source;

pub use diagnostic::{LifetimeDiagnostic, LifetimeError};
pub use lifetime::{
    LifecycleSource, PositionLifetime, PositionLifetimeHistory, RawActivityEvidence,
};
pub use normalization::{
    BookedPositionTransaction, NormalizationError, NormalizedPositionActivity,
};
pub use ownership::TransactionOwnership;
pub use replay::{PositionLifetimes, PositionReplayContext};
pub use source::{PositionTransaction, TransactionOrderProof};
