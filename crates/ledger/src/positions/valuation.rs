//! The value of one movement or reward in its pool's quote token, at its own transaction's bin.

use binsight_core::units::RawTokenAmount;
use binsight_dlmm::activity::{PositionMovement, RewardClaim};
use binsight_dlmm::math::price_from_bin;

use super::FoldError;
use crate::facts::{PhysicalSide, PoolFacts, QuoteUnits};
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

/// The value of a nonzero `reward` of a position of `pool`: its amount when it is paid in the
/// pool's quote token; its value at `bin`, the active bin of its own transaction, when it is paid
/// in the pool's base token; `None` for any other token, or a base-token reward without a bin.
pub(super) fn value_reward(
    reward: &RewardClaim,
    pool: &PoolFacts,
    bin: Option<i32>,
) -> Result<Option<QuoteUnits>, FoldError> {
    let Some(convention) = pool.quote_convention() else {
        return Ok(None);
    };
    let Some(mint) = reward.mint else {
        return Ok(None);
    };
    let zero = RawTokenAmount(0);
    let quoted = if mint == convention.quote_token(pool).mint {
        reward.amount
    } else if mint == convention.base_token(pool).mint {
        let Some(bin) = bin else {
            return Ok(None);
        };
        let price = price_from_bin(bin, pool.bin_step)?;
        let (x, y) = match convention.side() {
            PhysicalSide::Y => (reward.amount, zero),
            PhysicalSide::X => (zero, reward.amount),
        };
        convention.value_raw(x, y, Some(price))?.amount
    } else {
        return Ok(None);
    };
    let value = i128::try_from(quoted.0).map_err(|_| FoldError::Overflow)?;
    Ok(Some(QuoteUnits(value)))
}
