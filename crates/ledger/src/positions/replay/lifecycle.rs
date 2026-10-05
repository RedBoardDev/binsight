//! Apply real creation and successful closure facts to a staged transaction ownership delta.

use binsight_dlmm::activity::LifecycleFact;

use super::delta::{TransactionDelta, lifecycle_source};
use super::{KnownPosition, PositionLifetimes};
use crate::facts::PositionId;
use crate::positions::{LifetimeError, PositionLifetime, PositionTransaction, RawActivityEvidence};

pub(super) fn apply(
    delta: &mut TransactionDelta,
    replay: &PositionLifetimes,
    source: &PositionTransaction,
    fact: LifecycleFact,
) -> Result<(), LifetimeError> {
    match fact {
        LifecycleFact::Created {
            position,
            pool,
            owner,
            at,
        } => {
            let id = PositionId {
                address: position,
                opened_by: source.transaction.signature,
            };
            if replay.seen_ids.contains(&id) || delta.new_ids.contains(&id) {
                return Err(LifetimeError::PositionIdCollision { position: id });
            }
            if delta
                .known_position(replay, position)
                .is_some_and(|known| known.is_open)
            {
                return Err(LifetimeError::DuplicateCreation { position });
            }
            delta.new_ids.insert(id);
            delta.known.insert(
                position,
                KnownPosition {
                    id,
                    pool,
                    owner,
                    is_open: true,
                },
            );
            if owner == replay.context.wallet {
                delta.require_time(source);
                delta.ownership.positions.insert(position);
                delta.lifetimes.insert(
                    id,
                    PositionLifetime {
                        id,
                        pool,
                        owner,
                        opened: lifecycle_source(source, at),
                        closed: None,
                        raw_activity: RawActivityEvidence::Unknown,
                        has_nonzero: false,
                        has_unknown: false,
                    },
                );
            }
            Ok(())
        }
        LifecycleFact::Closed {
            position,
            owner,
            at,
        } => {
            let Some(mut known) = delta.known_position(replay, position) else {
                delta.missing_creation(source, position);
                return Ok(());
            };
            if known.owner != owner {
                return Err(LifetimeError::OwnerMismatch { position });
            }
            if !known.is_open {
                return Err(LifetimeError::DuplicateClosure { position });
            }
            if owner == replay.context.wallet {
                delta.require_time(source);
                delta.ownership.positions.insert(position);
                delta.lifetime(replay, known.id)?.closed = Some(lifecycle_source(source, at));
            }
            known.is_open = false;
            delta.known.insert(position, known);
            Ok(())
        }
    }
}
