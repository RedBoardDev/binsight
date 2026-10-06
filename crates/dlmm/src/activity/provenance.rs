//! An immutable derivation from one captured transaction, with original event provenance.
//!
//! This boundary proves which input was decoded, not its RPC provider or finalized registry
//! provenance. The adapter establishes those facts. Legacy accounting and persisted output stay
//! unchanged; missing multiplicity evidence is reported independently of amounts.

mod capture;
mod origin;

use binsight_solana::transaction::TransactionView;

use super::{ActivityError, TxActivity};
use crate::event::{DecodeError, LocatedEvent, decode_events};

pub(in crate::activity) use capture::Capture;
pub use origin::{
    ActivityDiagnostic, ActivityProvenance, ActivityRef, ClaimKind, EventEffect, EventSource,
};

/// One consumed transaction decoded once, together with its unchanged original activity.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DerivedPositionActivity {
    transaction: TransactionView,
    events: Vec<LocatedEvent>,
    activity: TxActivity,
    origins: Vec<ActivityProvenance>,
    diagnostics: Vec<ActivityDiagnostic>,
}

impl DerivedPositionActivity {
    /// The exact transaction consumed by this derivation.
    pub fn transaction(&self) -> &TransactionView {
        &self.transaction
    }

    /// The original decoded DLMM events, including emissions from failed transactions.
    pub fn events(&self) -> &[LocatedEvent] {
        &self.events
    }

    /// Unfiltered activity under the existing decoder rules.
    pub fn activity(&self) -> &TxActivity {
        &self.activity
    }

    /// Original event references in mixed source order, with named rebalance effects.
    pub fn origins(&self) -> &[ActivityProvenance] {
        &self.origins
    }

    /// Positive suppressed claims whose multiplicity lacks an emitter scope proof.
    pub fn diagnostics(&self) -> &[ActivityDiagnostic] {
        &self.diagnostics
    }
}

/// The immutable derivation could not decode its input or number its original event sequence.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum ActivityProvenanceError {
    /// Event decoding failed under the existing rules.
    #[error(transparent)]
    Decode(#[from] DecodeError),
    /// Lifecycle consistency failed under the existing rules.
    #[error(transparent)]
    Activity(#[from] ActivityError),
    /// The decoded event rank cannot be represented without truncation.
    #[error("the decoded event index {index} does not fit in u32")]
    EventIndexOverflow {
        /// The rank that would have been truncated.
        index: usize,
    },
}

/// Consumes and decodes this exact transaction once, retaining immutable activity provenance.
///
/// The adapter must supply a transaction read from its verified raw source. A parsed view alone
/// does not attest a provider, commitment or block order. No ownership or dated money is inferred.
///
/// # Errors
/// Returns the existing event or lifecycle error, or a checked event-index overflow. No partial
/// derivation is returned, and legacy persisted decoder outcomes are not changed.
pub fn derive_position_activity(
    transaction: TransactionView,
) -> Result<DerivedPositionActivity, ActivityProvenanceError> {
    let events = decode_events(&transaction)?;
    let mut capture = Capture::new(&events)?;
    let activity = super::collect_activity(&transaction, &events, &mut capture)?;
    let (origins, diagnostics) = capture.into_parts();
    Ok(DerivedPositionActivity {
        transaction,
        events,
        activity,
        origins,
        diagnostics,
    })
}
