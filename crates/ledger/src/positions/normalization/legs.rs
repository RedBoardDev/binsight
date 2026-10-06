//! Join raw book legs to original activity sources without matching by amount or position alone.

use std::collections::BTreeMap;

use binsight_core::units::RawTokenAmount;
use binsight_dlmm::activity::MovementKind;
use binsight_dlmm::pool_tokens::PoolTokens;
use binsight_solana::{Address, transaction::InstructionPosition};

use super::{NormalizationError, NormalizedPositionActivity};
use crate::book::{Asset, EntryKind, LedgerEntry, PositionActivitySource};
use crate::positions::{PositionTransaction, TransactionOwnership};

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum ActivityVector {
    Movements,
    RewardClaims,
}

type LegKey = (ActivityVector, usize, InstructionPosition, Address);

pub(in crate::positions) fn normalize(
    source: &PositionTransaction,
    ownership: &TransactionOwnership,
    entries: &[LedgerEntry],
) -> Result<Vec<NormalizedPositionActivity>, NormalizationError> {
    let mut legs = collect_legs(ownership, entries)?;
    let pools = PoolTokens::of(&source.transaction);
    let mut activities = Vec::new();
    for (index, original) in source.activity.movements.iter().enumerate() {
        let origin = PositionActivitySource::Movement {
            index,
            at: original.at,
        };
        let Some(position) = ownership.position_for(origin) else {
            continue;
        };
        let mints = pools.mints_of(&source.transaction, original);
        let mut movement = *original;
        let kind = movement_kind(original.kind, original.position);
        movement.x = take_leg(
            &mut legs,
            ExpectedLeg {
                origin,
                mint: mints.x,
                original: original.x,
                kind,
            },
        )?;
        movement.y = take_leg(
            &mut legs,
            ExpectedLeg {
                origin,
                mint: mints.y,
                original: original.y,
                kind,
            },
        )?;
        activities.push(NormalizedPositionActivity::Movement {
            source: origin,
            position,
            movement,
        });
    }
    for (index, original) in source.activity.reward_claims.iter().enumerate() {
        let origin = PositionActivitySource::RewardClaim {
            index,
            at: original.at,
        };
        let Some(position) = ownership.position_for(origin) else {
            continue;
        };
        let mut reward = *original;
        reward.amount = take_leg(
            &mut legs,
            ExpectedLeg {
                origin,
                mint: reward.mint,
                original: original.amount,
                kind: EntryKind::RewardClaim {
                    position: original.position,
                },
            },
        )?;
        activities.push(NormalizedPositionActivity::RewardClaim {
            source: origin,
            position,
            reward,
        });
    }
    if !legs.is_empty() {
        return Err(NormalizationError::InvalidLeg);
    }
    Ok(activities)
}

fn collect_legs(
    ownership: &TransactionOwnership,
    entries: &[LedgerEntry],
) -> Result<BTreeMap<LegKey, LedgerEntry>, NormalizationError> {
    let mut legs = BTreeMap::new();
    for entry in entries {
        let Some(origin) = entry.source else {
            if is_position(entry.kind) {
                return Err(NormalizationError::InvalidLeg);
            }
            continue;
        };
        let Asset::Token { mint } = entry.asset else {
            return Err(NormalizationError::InvalidLeg);
        };
        if ownership.position_for(origin).is_none() {
            if position_of(entry.kind)
                .is_some_and(|position| ownership.unknown_creations().contains(&position))
            {
                continue;
            }
            return Err(NormalizationError::InvalidLeg);
        }
        if legs.insert(key(origin, mint), *entry).is_some() {
            return Err(NormalizationError::DuplicateLeg);
        }
    }
    Ok(legs)
}

#[derive(Clone, Copy)]
struct ExpectedLeg {
    origin: PositionActivitySource,
    mint: Option<Address>,
    original: RawTokenAmount,
    kind: EntryKind,
}

fn take_leg(
    legs: &mut BTreeMap<LegKey, LedgerEntry>,
    expected: ExpectedLeg,
) -> Result<RawTokenAmount, NormalizationError> {
    let ExpectedLeg {
        origin,
        mint,
        original,
        kind,
    } = expected;
    if original.0 == 0 {
        return Ok(original);
    }
    let mint = mint.ok_or(NormalizationError::InvalidLeg)?;
    let entry = legs
        .remove(&key(origin, mint))
        .ok_or(NormalizationError::MissingLeg)?;
    if entry.kind != kind {
        return Err(NormalizationError::InvalidLeg);
    }
    let deposit = matches!(kind, EntryKind::PositionDeposit { .. });
    let signed = if deposit {
        entry.amount.checked_neg()
    } else {
        Some(entry.amount)
    };
    let amount = signed
        .and_then(|value| u128::try_from(value).ok())
        .ok_or(NormalizationError::InvalidLeg)?;
    if amount > original.0 || (!deposit && amount != original.0) {
        return Err(NormalizationError::InvalidLeg);
    }
    Ok(RawTokenAmount(amount))
}

fn key(origin: PositionActivitySource, mint: Address) -> LegKey {
    match origin {
        PositionActivitySource::Movement { index, at } => {
            (ActivityVector::Movements, index, at, mint)
        }
        PositionActivitySource::RewardClaim { index, at } => {
            (ActivityVector::RewardClaims, index, at, mint)
        }
    }
}

fn movement_kind(kind: MovementKind, position: Address) -> EntryKind {
    match kind {
        MovementKind::Deposit | MovementKind::RebalanceDeposit => {
            EntryKind::PositionDeposit { position }
        }
        MovementKind::Withdrawal | MovementKind::RebalanceWithdrawal => {
            EntryKind::PositionWithdrawal { position }
        }
        MovementKind::FeeClaim => EntryKind::FeeClaim { position },
    }
}

fn is_position(kind: EntryKind) -> bool {
    position_of(kind).is_some()
}

/// The position a position leg moved, if `kind` is one.
fn position_of(kind: EntryKind) -> Option<Address> {
    match kind {
        EntryKind::PositionDeposit { position }
        | EntryKind::PositionWithdrawal { position }
        | EntryKind::FeeClaim { position }
        | EntryKind::RewardClaim { position } => Some(position),
        _ => None,
    }
}
