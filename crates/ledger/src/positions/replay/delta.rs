//! Stage only touched position/lifetime records, then commit them after full transaction validation.

use std::collections::{BTreeMap, BTreeSet, btree_map::Entry};

use binsight_dlmm::activity::LifecycleFact;
use binsight_solana::Address;
use binsight_solana::transaction::InstructionPosition;

use super::actions::{self, Action};
use super::{KnownPosition, PositionLifetimes};
use crate::book::{PositionActivitySource, moves_wallet_tokens};
use crate::facts::PositionId;
use crate::positions::{
    LifecycleSource, LifetimeDiagnostic, LifetimeError, PositionActivityOwnership,
    PositionLifetime, PositionTransaction, TransactionOwnership,
};

pub(super) struct TransactionDelta {
    pub(super) known: BTreeMap<Address, KnownPosition>,
    pub(super) lifetimes: BTreeMap<PositionId, PositionLifetime>,
    pub(super) new_ids: BTreeSet<PositionId>,
    pub(super) ownership: TransactionOwnership,
}

impl TransactionDelta {
    pub(super) fn build(
        replay: &PositionLifetimes,
        source: &PositionTransaction,
    ) -> Result<Self, LifetimeError> {
        actions::validate_owners(replay, source)?;
        let mut delta = Self {
            known: BTreeMap::new(),
            lifetimes: BTreeMap::new(),
            new_ids: BTreeSet::new(),
            ownership: TransactionOwnership::default(),
        };
        if !replay.context.sources_contiguous {
            delta.ownership.unresolved = true;
            delta.diagnose(LifetimeDiagnostic::NoncontiguousSources);
        }
        if source.order.is_none() {
            delta.diagnose(LifetimeDiagnostic::MissingTransactionOrder {
                signature: source.transaction.signature,
            });
        }
        for balance in &source.transaction.native_balances {
            if let Some(known) = replay.known.get(&balance.account)
                && known.is_open
                && known.owner == replay.context.wallet
            {
                delta.ownership.positions.insert(balance.account);
            }
        }
        for action in actions::collect(source)? {
            delta.apply_action(replay, source, action)?;
        }
        if source.activity.has_unknown_program_activity {
            delta.mark_unknown(replay, source)?;
        }
        Ok(delta)
    }

    fn apply_action(
        &mut self,
        replay: &PositionLifetimes,
        source: &PositionTransaction,
        action: Action,
    ) -> Result<(), LifetimeError> {
        match action {
            Action::Lifecycle(index, fact) => {
                super::lifecycle::apply(self, replay, source, fact)?;
                let (position, at) = match fact {
                    LifecycleFact::Created { position, at, .. }
                    | LifecycleFact::Closed { position, at, .. } => (position, at),
                };
                if let Some(known) = self.known_position(replay, position)
                    && known.owner == replay.context.wallet
                {
                    self.ownership.lifecycle_sources.push((index, at, known.id));
                }
                Ok(())
            }
            Action::Movement(index, movement) => self.observe(
                replay,
                source,
                ActivityObservation {
                    origin: PositionActivitySource::Movement {
                        index,
                        at: movement.at,
                    },
                    position: movement.position,
                    pool: movement.pool,
                    has_nonzero: movement.x.0 != 0 || movement.y.0 != 0,
                },
            ),
            Action::Reward(index, reward) => self.observe(
                replay,
                source,
                ActivityObservation {
                    origin: PositionActivitySource::RewardClaim {
                        index,
                        at: reward.at,
                    },
                    position: reward.position,
                    pool: reward.pool,
                    has_nonzero: reward.amount.0 != 0,
                },
            ),
        }
    }

    fn observe(
        &mut self,
        replay: &PositionLifetimes,
        source: &PositionTransaction,
        activity: ActivityObservation,
    ) -> Result<(), LifetimeError> {
        let Some(known) = self.known_position(replay, activity.position) else {
            self.missing_creation(source, activity.position);
            if moves_wallet_tokens(replay.context.wallet, &source.transaction, activity.at()) {
                self.ownership.positions.insert(activity.position);
                self.ownership.unknown_creations.insert(activity.position);
            }
            return Ok(());
        };
        if !known.is_open {
            return Err(LifetimeError::MovementOutsideLifetime {
                position: activity.position,
            });
        }
        if known.pool != activity.pool {
            return Err(LifetimeError::PoolMismatch {
                position: activity.position,
            });
        }
        let ownership = if known.owner == replay.context.wallet {
            PositionActivityOwnership::Owned(known.id)
        } else {
            PositionActivityOwnership::Foreign(known.id)
        };
        self.ownership.sources.push((activity.origin, ownership));
        if matches!(ownership, PositionActivityOwnership::Owned(_)) {
            self.ownership.positions.insert(activity.position);
            self.require_time(source);
            self.lifetime(replay, known.id)?.has_nonzero |= activity.has_nonzero;
        }
        Ok(())
    }

    fn mark_unknown(
        &mut self,
        replay: &PositionLifetimes,
        source: &PositionTransaction,
    ) -> Result<(), LifetimeError> {
        self.diagnose(LifetimeDiagnostic::UnknownProgramActivity {
            signature: source.transaction.signature,
        });
        // An unknown opcode cannot reliably name its affected positions. Conservatively
        // retain uncertainty for every life active during the transaction, including closures.
        let active: BTreeSet<_> = replay
            .known
            .values()
            .chain(self.known.values())
            .filter(|known| known.owner == replay.context.wallet)
            .filter(|known| known.is_open || self.lifetimes.contains_key(&known.id))
            .map(|known| known.id)
            .collect();
        for id in active {
            self.lifetime(replay, id)?.has_unknown = true;
        }
        Ok(())
    }

    pub(super) fn known_position(
        &self,
        replay: &PositionLifetimes,
        position: Address,
    ) -> Option<KnownPosition> {
        self.known
            .get(&position)
            .or_else(|| replay.known.get(&position))
            .copied()
    }

    pub(super) fn lifetime(
        &mut self,
        replay: &PositionLifetimes,
        id: PositionId,
    ) -> Result<&mut PositionLifetime, LifetimeError> {
        match self.lifetimes.entry(id) {
            Entry::Occupied(entry) => Ok(entry.into_mut()),
            Entry::Vacant(entry) => replay
                .lifetimes
                .get(&id)
                .cloned()
                .map(|lifetime| entry.insert(lifetime))
                .ok_or(LifetimeError::MissingKnownLifetime { position: id }),
        }
    }

    /// Records that `position` moved without a known creation. The transaction still books:
    /// the position is only left without an identity, and its figures without this history.
    pub(super) fn missing_creation(&mut self, source: &PositionTransaction, position: Address) {
        self.diagnose(LifetimeDiagnostic::MissingCreation {
            position,
            signature: source.transaction.signature,
        });
    }

    pub(super) fn require_time(&mut self, source: &PositionTransaction) {
        if source.transaction.block_time.is_none() {
            self.diagnose(LifetimeDiagnostic::MissingBlockTime {
                signature: source.transaction.signature,
            });
        }
    }

    fn diagnose(&mut self, diagnostic: LifetimeDiagnostic) {
        if !self.ownership.diagnostics.contains(&diagnostic) {
            self.ownership.diagnostics.push(diagnostic);
        }
    }
}

#[derive(Debug, Clone, Copy)]
struct ActivityObservation {
    origin: PositionActivitySource,
    position: Address,
    pool: Address,
    has_nonzero: bool,
}

impl ActivityObservation {
    /// The event that reported the activity.
    fn at(self) -> InstructionPosition {
        match self.origin {
            PositionActivitySource::Movement { at, .. }
            | PositionActivitySource::RewardClaim { at, .. } => at,
        }
    }
}

pub(super) fn lifecycle_source(
    source: &PositionTransaction,
    instruction: InstructionPosition,
) -> LifecycleSource {
    LifecycleSource {
        signature: source.transaction.signature,
        slot: source.transaction.slot,
        transaction_index: source.transaction.transaction_index,
        order: source.order,
        at: source.transaction.block_time,
        instruction,
    }
}
