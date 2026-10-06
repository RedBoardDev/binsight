//! Original decoded event references and named effects, distinct from financial cursor ranks.

use binsight_solana::{Address, transaction::InstructionPosition};

/// A row in the original, unfiltered activity vectors.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ActivityRef {
    /// A lifecycle row.
    Lifecycle {
        /// Its original row in the lifecycle vector.
        index: usize,
    },
    /// A pool movement row.
    Movement {
        /// Its original row in the movements vector.
        index: usize,
    },
    /// A reward row; this index is not the program's reward index.
    RewardClaim {
        /// Its original row in the reward vector.
        index: usize,
    },
}

/// One logical effect of an event, without inventing additional chain emissions.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EventEffect {
    /// An event with a single position effect.
    Single,
    /// Liquidity removed by a rebalance.
    RebalanceWithdrawal,
    /// Liquidity redeposited by a rebalance.
    RebalanceDeposit,
    /// Fees harvested by a rebalance.
    RebalanceFees,
    /// The first reward harvested by a rebalance.
    RebalanceReward0,
    /// The second reward harvested by a rebalance.
    RebalanceReward1,
}

/// A reference into the decoded DLMM event sequence, never a global RPC log index.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EventSource {
    index: u32,
    at: InstructionPosition,
}

impl EventSource {
    pub(in crate::activity) fn new(index: u32, at: InstructionPosition) -> Self {
        Self { index, at }
    }

    /// Its original rank among the transaction's decoded DLMM events.
    pub fn decoded_event_index(self) -> u32 {
        self.index
    }

    /// The original event instruction.
    pub fn at(self) -> InstructionPosition {
        self.at
    }
}

/// The event and named logical effect which produced one original activity row.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ActivityProvenance {
    row: ActivityRef,
    source: EventSource,
    effect: EventEffect,
}

impl ActivityProvenance {
    pub(super) fn new(row: ActivityRef, source: EventSource, effect: EventEffect) -> Self {
        Self {
            row,
            source,
            effect,
        }
    }

    /// Its row in the original activity, before any ownership filtering.
    pub fn row(self) -> ActivityRef {
        self.row
    }

    /// Its actual decoded event source.
    pub fn source(self) -> EventSource {
        self.source
    }

    /// Its logical effect; rebalance effects share one event source.
    pub fn effect(self) -> EventEffect {
        self.effect
    }
}

/// Which claim was suppressed without proof of its paying instruction.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClaimKind {
    /// A pool fee claim.
    Fee,
    /// A farming reward claim.
    Reward,
}

/// Missing evidence of a claim's multiplicity, without changing legacy deduplication.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ActivityDiagnostic {
    position: Address,
    kind: ClaimKind,
    suppressed: EventSource,
    representative: EventSource,
}

impl ActivityDiagnostic {
    pub(in crate::activity) fn new(
        position: Address,
        kind: ClaimKind,
        sources: (EventSource, EventSource),
    ) -> Self {
        Self {
            position,
            kind,
            suppressed: sources.0,
            representative: sources.1,
        }
    }

    /// The position whose positive claim cannot be counted with full confidence.
    pub fn position(self) -> Address {
        self.position
    }

    /// Whether this concerns pool fees or a farming reward.
    pub fn kind(self) -> ClaimKind {
        self.kind
    }

    /// The event suppressed by the existing rule.
    pub fn suppressed(self) -> EventSource {
        self.suppressed
    }

    /// The event retained instead, or the report that caused suppression.
    pub fn representative(self) -> EventSource {
        self.representative
    }
}
