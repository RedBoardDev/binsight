//! The value of one movement or reward in its pool's quote token, at its own transaction's bin.

use binsight_core::units::RawTokenAmount;
use binsight_dlmm::activity::{MovementKind, PositionMovement, RewardClaim};
use binsight_dlmm::math::price_from_bin;
use binsight_solana::Address;

use super::FoldError;
use crate::book::{Asset, LedgerEntry, PositionActivitySource};
use crate::facts::{PoolFacts, QuoteUnits};
use crate::report::valued::quote::QuotedAmount;

/// One movement of a transaction, with the entries that booked it.
#[derive(Clone, Copy)]
pub(super) struct BookedMovement<'a> {
    /// Its row in the transaction's activity.
    pub(super) index: usize,
    /// The movement.
    pub(super) movement: &'a PositionMovement,
    /// The transaction's entries.
    pub(super) entries: &'a [LedgerEntry],
}

/// The value of `booked` in the quote token of `pool`, its own pool; `None` when the pool has no
/// supported quote token.
pub(super) fn value_movement(
    booked: BookedMovement<'_>,
    pool: &PoolFacts,
) -> Result<Option<QuotedAmount>, FoldError> {
    let Some(convention) = pool.quote_convention() else {
        return Ok(None);
    };
    let movement = booked.movement;
    let (x, y) = match movement.kind {
        MovementKind::Deposit | MovementKind::RebalanceDeposit => (
            deposited(booked, pool.base.mint, movement.x)?,
            deposited(booked, pool.quote.mint, movement.y)?,
        ),
        MovementKind::Withdrawal | MovementKind::RebalanceWithdrawal | MovementKind::FeeClaim => {
            (movement.x, movement.y)
        }
    };
    let price = movement
        .price_bin
        .map(|bin| price_from_bin(bin, pool.bin_step))
        .transpose()?;
    Ok(Some(convention.value_raw(x, y, price)?))
}

/// The value of a nonzero `reward` of a position of `pool`, when it is paid in the pool's quote
/// token; no price is known for any other token.
pub(super) fn value_reward(reward: &RewardClaim, pool: &PoolFacts) -> Option<QuoteUnits> {
    let quote = pool.quote_convention()?.quote_token(pool).mint;
    if reward.mint != Some(quote) {
        return None;
    }
    i128::try_from(reward.amount.0).ok().map(QuoteUnits)
}

/// What a deposit put into its position in `mint`: the wallet's booked payment, which leaves out
/// a Token-2022 transfer fee the event may include.
fn deposited(
    booked: BookedMovement<'_>,
    mint: Address,
    reported: RawTokenAmount,
) -> Result<RawTokenAmount, FoldError> {
    if reported.0 == 0 {
        return Ok(reported);
    }
    let source = PositionActivitySource::Movement {
        index: booked.index,
        at: booked.movement.at,
    };
    let leg = booked
        .entries
        .iter()
        .find(|entry| entry.source == Some(source) && entry.asset == Asset::Token { mint })
        .ok_or(FoldError::MissingDepositLeg {
            position: booked.movement.position,
            mint,
        })?;
    leg.amount
        .checked_neg()
        .and_then(|paid| u128::try_from(paid).ok())
        .map(RawTokenAmount)
        .ok_or(FoldError::Overflow)
}
