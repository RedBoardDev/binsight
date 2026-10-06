//! One transaction applied to a copy of the open lives, kept only when every action succeeds.

use std::collections::{BTreeMap, BTreeSet, btree_map::Entry};

use binsight_dlmm::activity::{LifecycleFact, PositionMovement, RewardClaim, TxActivity};
use binsight_solana::Address;
use binsight_solana::transaction::{InstructionPosition, TransactionView};
use jiff::Timestamp;

use super::PositionFold;
use crate::facts::{ClosedPositionFacts, PoolFacts, PositionId};
use crate::positions::valuation::{value_movement, value_reward};
use crate::positions::{FoldError, OpenLife};

/// What one transaction brings to the fold.
#[derive(Clone, Copy)]
pub(super) struct Sources<'a> {
    /// The positions the wallet owns in it, as booked.
    pub(super) owned: &'a BTreeSet<Address>,
    /// The transaction.
    pub(super) tx: &'a TransactionView,
    /// Its DLMM activity.
    pub(super) activity: &'a TxActivity,
    /// The facts of the pools its movements may name.
    pub(super) pools: &'a BTreeMap<Address, PoolFacts>,
}

/// The open lives and other owners' positions after the transaction, and the lives it closed.
pub(super) struct StepOutcome {
    pub(super) open: BTreeMap<Address, OpenLife>,
    pub(super) foreign: BTreeSet<Address>,
    pub(super) closed: Vec<ClosedPositionFacts>,
    pub(super) missing_creations: u32,
}

/// The transaction being applied.
pub(super) struct Step<'a> {
    wallet: Address,
    sources: Sources<'a>,
    outcome: StepOutcome,
}

/// One activity row of the transaction.
#[derive(Clone, Copy)]
enum Action<'a> {
    Lifecycle(&'a LifecycleFact),
    Movement(&'a PositionMovement),
    Reward(&'a RewardClaim),
}

impl Action<'_> {
    /// Instruction order; within one instruction a creation comes first and a closure last.
    fn order(self) -> (InstructionPosition, u8) {
        match self {
            Self::Lifecycle(LifecycleFact::Created { at, .. }) => (*at, 0),
            Self::Movement(movement) => (movement.at, 1),
            Self::Reward(reward) => (reward.at, 1),
            Self::Lifecycle(LifecycleFact::Closed { at, .. }) => (*at, 2),
        }
    }
}

impl<'a> Step<'a> {
    pub(super) fn new(fold: &PositionFold, sources: Sources<'a>) -> Self {
        Self {
            wallet: fold.context.wallet,
            sources,
            outcome: StepOutcome {
                open: fold.open.clone(),
                foreign: fold.foreign.clone(),
                closed: Vec::new(),
                missing_creations: 0,
            },
        }
    }

    /// Applies every activity row of the transaction, in instruction order.
    pub(super) fn apply(&mut self) -> Result<(), FoldError> {
        let activity = self.sources.activity;
        let mut actions: Vec<Action<'a>> = activity
            .lifecycle
            .iter()
            .map(Action::Lifecycle)
            .chain(activity.movements.iter().map(Action::Movement))
            .chain(activity.reward_claims.iter().map(Action::Reward))
            .collect();
        actions.sort_by_key(|action| action.order());
        for action in actions {
            match action {
                Action::Lifecycle(fact) => self.apply_lifecycle(*fact)?,
                Action::Movement(movement) => self.apply_movement(movement)?,
                Action::Reward(reward) => self.apply_reward(reward)?,
            }
        }
        Ok(())
    }

    pub(super) fn finish(self) -> StepOutcome {
        self.outcome
    }

    fn apply_lifecycle(&mut self, fact: LifecycleFact) -> Result<(), FoldError> {
        match fact {
            LifecycleFact::Created {
                position,
                pool,
                owner,
                ..
            } => {
                if self.outcome.open.contains_key(&position) {
                    return Err(FoldError::CreatedWhileOpen { position });
                }
                if owner != self.wallet {
                    self.outcome.foreign.insert(position);
                    return Ok(());
                }
                let id = self.identity(position);
                if self.outcome.closed.iter().any(|closed| closed.id == id) {
                    return Err(FoldError::IdentityCollision { position });
                }
                self.outcome.foreign.remove(&position);
                let life = OpenLife::new(id, pool, self.block_time()?);
                self.outcome.open.insert(position, life);
            }
            LifecycleFact::Closed {
                position, owner, ..
            } => {
                if owner != self.wallet {
                    if self.outcome.open.contains_key(&position) {
                        return Err(FoldError::ClosedByAnotherOwner { position });
                    }
                    self.outcome.foreign.remove(&position);
                    return Ok(());
                }
                let closed_at = self.block_time()?;
                let Some(life) = self.outcome.open.remove(&position) else {
                    // Nothing of this life is in the history: no pool, no figure to show.
                    return self.count_missing_creation();
                };
                self.outcome.closed.push(life.close(self.wallet, closed_at));
            }
        }
        Ok(())
    }

    fn apply_movement(&mut self, movement: &PositionMovement) -> Result<(), FoldError> {
        if !self.sources.owned.contains(&movement.position)
            || (movement.x.0 == 0 && movement.y.0 == 0)
        {
            return Ok(());
        }
        let quoted = value_movement(movement, self.pool(movement.pool)?)?;
        self.life(movement.position, movement.pool)?
            .flows
            .add_movement(movement.kind, quoted)
    }

    fn apply_reward(&mut self, reward: &RewardClaim) -> Result<(), FoldError> {
        if !self.sources.owned.contains(&reward.position) || reward.amount.0 == 0 {
            return Ok(());
        }
        let value = value_reward(reward, self.pool(reward.pool)?);
        self.life(reward.position, reward.pool)?
            .flows
            .add_reward(value)
    }

    /// The open life of `position`, started here when its creation is not in the history.
    fn life(&mut self, position: Address, pool: Address) -> Result<&mut OpenLife, FoldError> {
        let tx = self.sources.tx;
        match self.outcome.open.entry(position) {
            Entry::Occupied(entry) => Ok(entry.into_mut()),
            Entry::Vacant(entry) => {
                let opened_at = tx.block_time.ok_or(FoldError::MissingBlockTime {
                    signature: tx.signature,
                })?;
                let reused = |closed: &ClosedPositionFacts| {
                    closed.id.address == position && closed.id.opened_by == tx.signature
                };
                if self.outcome.closed.iter().any(reused) {
                    return Err(FoldError::IdentityCollision { position });
                }
                count_missing_creation(&mut self.outcome.missing_creations)?;
                let id = PositionId {
                    address: position,
                    opened_by: tx.signature,
                };
                Ok(entry.insert(OpenLife::new(id, pool, opened_at)))
            }
        }
    }

    fn pool(&self, pool: Address) -> Result<&'a PoolFacts, FoldError> {
        self.sources
            .pools
            .get(&pool)
            .ok_or(FoldError::MissingPool { pool })
    }

    fn identity(&self, position: Address) -> PositionId {
        PositionId {
            address: position,
            opened_by: self.sources.tx.signature,
        }
    }

    fn block_time(&self) -> Result<Timestamp, FoldError> {
        self.sources
            .tx
            .block_time
            .ok_or(FoldError::MissingBlockTime {
                signature: self.sources.tx.signature,
            })
    }

    fn count_missing_creation(&mut self) -> Result<(), FoldError> {
        count_missing_creation(&mut self.outcome.missing_creations)
    }
}

fn count_missing_creation(count: &mut u32) -> Result<(), FoldError> {
    *count = count.checked_add(1).ok_or(FoldError::Overflow)?;
    Ok(())
}
