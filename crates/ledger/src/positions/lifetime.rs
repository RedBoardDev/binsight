//! A proved life identity and its raw activity evidence, independent of price and transfer tax.

use binsight_solana::transaction::InstructionPosition;
use binsight_solana::{Address, Signature};
use jiff::Timestamp;

use super::{LifetimeDiagnostic, PositionReplayContext, TransactionOrderProof};
use crate::facts::PositionId;

/// Where one lifecycle event occurred; a missing date does not erase the lifecycle event.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LifecycleSource {
    /// Its transaction signature.
    pub signature: Signature,
    /// The slot from the original transaction.
    pub slot: u64,
    /// The original block index, retained even when a listing ordinal supplies ordering.
    pub transaction_index: Option<u32>,
    /// Ordering provenance, never coerced into a canonical block index.
    pub order: Option<TransactionOrderProof>,
    /// Its block time, if actually present.
    pub at: Option<Timestamp>,
    /// The instruction carrying the event.
    pub instruction: InstructionPosition,
}

/// Whether raw position activity proves that this life is an empty shell.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RawActivityEvidence {
    /// The entire life is covered by contiguous sources with no unknown relevant activity.
    ProvenEmpty,
    /// A positive gross X/Y or reward amount was observed, even when net or quote value is zero.
    ObservedNonzero,
    /// Gaps, unknown activity or absent dates prevent proving an empty shell.
    Unknown,
}

/// One life created by a real `PositionCreate` owner, with no reconstructed creation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PositionLifetime {
    /// The existing address-plus-creating-signature identity.
    pub id: PositionId,
    /// The pool established by its creation.
    pub pool: Address,
    /// The owner established by its creation, independently of the signer.
    pub owner: Address,
    /// Its creation source; a missing time remains unavailable.
    pub opened: LifecycleSource,
    /// Its successful closure source; `Some` with no time still means closed.
    pub closed: Option<LifecycleSource>,
    /// Final proof from raw activity, coverage and source availability.
    pub raw_activity: RawActivityEvidence,
    pub(super) has_nonzero: bool,
    pub(super) has_unknown: bool,
}

/// Known open and closed lives together with every unresolved diagnostic.
///
/// This output does not announce financial completeness or turn unresolved positions into
/// foreign ones. Consumers must retain its diagnostics and source ordering provenance.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PositionLifetimeHistory {
    /// The coverage and observation boundary supplied by the adapter.
    pub context: PositionReplayContext,
    /// Known lives of this wallet, each carrying its original identity and lifecycle sources.
    pub lifetimes: Vec<PositionLifetime>,
    /// Unresolved evidence across the replay, including missing creations with no known ID.
    pub diagnostics: Vec<LifetimeDiagnostic>,
}
