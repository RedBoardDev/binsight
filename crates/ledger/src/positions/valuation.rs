//! The value of one movement or reward in its pool's quote token, at its own transaction's bin.

use binsight_dlmm::activity::{PositionMovement, RewardClaim};
use binsight_dlmm::math::price_from_bin;

use super::FoldError;
use crate::facts::{PoolFacts, QuoteUnits};
use crate::report::valued::quote::QuotedAmount;

/// The value of `movement` in the quote token of `pool`, its own pool, at the bin of its own
/// transaction; `None` when the pool has no supported quote token. The amounts are the event's:
/// a deposit counts what the wallet paid, a Token-2022 fee withheld on the way in included.
pub(super) fn value_movement(
    movement: &PositionMovement,
    pool: &PoolFacts,
) -> Result<Option<QuotedAmount>, FoldError> {
    let Some(convention) = pool.quote_convention() else {
        return Ok(None);
    };
    let price = movement
        .price_bin
        .map(|bin| price_from_bin(bin, pool.bin_step))
        .transpose()?;
    Ok(Some(convention.value_raw(movement.x, movement.y, price)?))
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
