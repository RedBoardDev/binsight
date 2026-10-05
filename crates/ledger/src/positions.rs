//! Replay proved position lifetimes and ownership before booking each wallet transaction.
//!
//! Sources retain the raw transaction, original activity and explicit ordering provenance.
//! Raw quotations require injected pool facts and keep their selected convention explicit.
//! This module reads neither storage, the network nor a clock. Missing creation or dates
//! remain visible diagnostics; no position identity is reconstructed.

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
    QuotedPositionTransaction, SelectedPoolMovement, ValuationError,
};
pub use ownership::TransactionOwnership;
pub use replay::{PositionLifetimes, PositionReplayContext};
pub use source::{PositionTransaction, TransactionOrderProof};
