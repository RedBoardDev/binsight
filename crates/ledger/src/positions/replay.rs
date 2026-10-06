//! Transactional replay of ownership deltas; facts and booking consume its proved output later.

mod actions;
mod booking;
mod delta;
mod evidence;
mod lifecycle;
mod order;

use std::collections::{BTreeMap, BTreeSet};

use binsight_solana::{Address, Signature};
use jiff::Timestamp;

use super::{
    LifetimeDiagnostic, LifetimeError, PositionLifetime, PositionLifetimeHistory,
    PositionTransaction, TransactionOwnership,
};
use crate::facts::{HistoryCoverage, PositionId};
use order::LastTransaction;

/// Coverage and observation provenance supplied by the adapter, never inferred from a cursor.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PositionReplayContext {
    /// The wallet whose position ownership is replayed.
    pub wallet: Address,
    /// Existing history coverage, proved from actually available transactions.
    pub history: HistoryCoverage,
    /// The injected observation boundary through which the adapter established availability.
    pub observed_at: Timestamp,
    /// Whether all needed sources are actually available contiguously through the boundary.
    /// This also requires a consistent metadata snapshot for any wallet-local ordinal ranks.
    pub sources_contiguous: bool,
}

#[derive(Debug, Clone, Copy)]
struct KnownPosition {
    id: PositionId,
    pool: Address,
    owner: Address,
    is_open: bool,
}

/// Replay known creations and closures before accounting for a wallet transaction.
///
/// `apply` commits only a fully validated delta. Missing evidence is retained separately from
/// contradictions. A position touched without a known creation does not stop the transaction:
/// it counts as the wallet's when its movement moved the wallet's own tokens, without an
/// identity, and a diagnostic says its history is missing. Non-contiguous sources still refuse
/// a book context instead of pretending foreign.
#[derive(Debug)]
pub struct PositionLifetimes {
    context: PositionReplayContext,
    known: BTreeMap<Address, KnownPosition>,
    lifetimes: BTreeMap<PositionId, PositionLifetime>,
    seen_ids: BTreeSet<PositionId>,
    seen_transactions: BTreeSet<Signature>,
    last: Option<LastTransaction>,
    diagnostics: Vec<LifetimeDiagnostic>,
}

impl PositionLifetimes {
    /// Starts with no inferred creation or permanently owned address.
    pub fn new(context: PositionReplayContext) -> Self {
        Self {
            context,
            known: BTreeMap::new(),
            lifetimes: BTreeMap::new(),
            seen_ids: BTreeSet::new(),
            seen_transactions: BTreeSet::new(),
            last: None,
            diagnostics: if context.sources_contiguous {
                Vec::new()
            } else {
                vec![LifetimeDiagnostic::NoncontiguousSources]
            },
        }
    }

    /// Resolves this transaction's ownership without booking or filtering its activity.
    ///
    /// # Errors
    /// Returns [`LifetimeError`] for contradictory identity, order, owner, pool or lifecycle
    /// evidence. No replay state changes on an error. Missing creations return diagnostics, and
    /// non-contiguous sources a [`TransactionOwnership`] whose book-context accessor refuses.
    pub fn apply(
        &mut self,
        source: &PositionTransaction,
    ) -> Result<TransactionOwnership, LifetimeError> {
        let last = order::validate(self, source)?;
        let delta = delta::TransactionDelta::build(self, source)?;
        Ok(self.commit_delta(source, last, delta))
    }

    fn commit_delta(
        &mut self,
        source: &PositionTransaction,
        last: LastTransaction,
        delta: delta::TransactionDelta,
    ) -> TransactionOwnership {
        self.known.extend(delta.known);
        self.lifetimes.extend(delta.lifetimes);
        self.seen_ids.extend(delta.new_ids);
        self.seen_transactions.insert(source.transaction.signature);
        self.last = Some(last);
        self.diagnostics
            .extend(delta.ownership.diagnostics.iter().copied());
        delta.ownership
    }

    /// Returns every known open/closed life and every unresolved diagnostic.
    ///
    /// Empty-shell evidence requires coverage of the whole life, actually contiguous sources
    /// and no relevant unknown activity. Positive raw activity dominates missing evidence.
    pub fn finish(mut self) -> PositionLifetimeHistory {
        let mut lifetimes: Vec<_> = self.lifetimes.into_values().collect();
        for lifetime in &mut lifetimes {
            evidence::finish(lifetime, self.context, &mut self.diagnostics);
        }
        PositionLifetimeHistory {
            context: self.context,
            lifetimes,
            diagnostics: self.diagnostics,
        }
    }
}
