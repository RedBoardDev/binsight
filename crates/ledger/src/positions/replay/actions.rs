//! Merge activity references by instruction without renumbering their original source vectors.

use std::collections::BTreeMap;

use binsight_dlmm::activity::{LifecycleFact, PositionMovement, RewardClaim};
use binsight_solana::Address;
use binsight_solana::transaction::InstructionPosition;

use super::PositionLifetimes;
use crate::positions::{LifetimeError, PositionTransaction};

#[derive(Debug, Clone, Copy)]
pub(super) enum Action {
    Lifecycle(LifecycleFact),
    Movement(usize, PositionMovement),
    Reward(usize, RewardClaim),
}

impl Action {
    fn location(self) -> (Address, InstructionPosition) {
        match self {
            Self::Lifecycle(
                LifecycleFact::Created { position, at, .. }
                | LifecycleFact::Closed { position, at, .. },
            ) => (position, at),
            Self::Movement(_, movement) => (movement.position, movement.at),
            Self::Reward(_, reward) => (reward.position, reward.at),
        }
    }
}

pub(super) fn collect(source: &PositionTransaction) -> Result<Vec<Action>, LifetimeError> {
    let activity = &source.activity;
    let mut actions: Vec<_> = activity
        .lifecycle
        .iter()
        .copied()
        .map(Action::Lifecycle)
        .chain(
            activity
                .movements
                .iter()
                .copied()
                .enumerate()
                .map(|(index, movement)| Action::Movement(index, movement)),
        )
        .chain(
            activity
                .reward_claims
                .iter()
                .copied()
                .enumerate()
                .map(|(index, reward)| Action::Reward(index, reward)),
        )
        .collect();
    let mut locations = BTreeMap::<_, bool>::new();
    for action in &actions {
        let location = action.location();
        let lifecycle = matches!(action, Action::Lifecycle(_));
        if let Some(previous_lifecycle) = locations.insert(location, lifecycle)
            && (previous_lifecycle || lifecycle)
        {
            return Err(LifetimeError::AmbiguousActivityOrder {
                position: location.0,
                at: location.1,
            });
        }
    }
    actions.sort_by_key(|action| action.location().1);
    Ok(actions)
}

pub(super) fn validate_owners(
    replay: &PositionLifetimes,
    source: &PositionTransaction,
) -> Result<(), LifetimeError> {
    let mut owners = BTreeMap::new();
    for fact in &source.activity.lifecycle {
        let (position, owner) = match *fact {
            LifecycleFact::Created {
                position, owner, ..
            }
            | LifecycleFact::Closed {
                position, owner, ..
            } => (position, owner),
        };
        if let Some(previous) = owners.insert(position, owner)
            && previous != owner
        {
            return Err(LifetimeError::AmbiguousOwnershipWithinTransaction { position });
        }
        if let Some(known) = replay.known.get(&position)
            && known.is_open
            && known.owner != owner
        {
            return Err(LifetimeError::OwnerMismatch { position });
        }
    }
    Ok(())
}
