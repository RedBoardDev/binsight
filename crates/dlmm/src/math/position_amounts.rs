//! Raw liquidity and fees from decoded snapshots, without pricing, rewards or network access.

use binsight_core::{error::AmountError, units::RawTokenAmount};
use binsight_solana::Address;
use thiserror::Error;

use super::{Q64x64, mul_shr_64, proportional_amount::proportional_amount, q64::FRACTION_BITS};
use crate::accounts::{Bin, BinLookup, PositionBin, PositionV2};

/// Known raw balances; absent arrays with positive liquidity make these lower bounds.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PositionAmounts {
    /// X owned by liquidity, excluding fees.
    pub amount_x: RawTokenAmount,
    /// Y owned by liquidity, excluding fees.
    pub amount_y: RawTokenAmount,
    /// Pending and unsettled X fees.
    pub fee_x: RawTokenAmount,
    /// Pending and unsettled Y fees.
    pub fee_y: RawTokenAmount,
    /// Whether every bin with positive liquidity was available.
    pub is_complete: bool,
}

/// Snapshot inconsistencies that prevent an exact position valuation.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum PositionValueError {
    /// Position and arrays belong to different pools.
    #[error("position pool {expected} differs from bin lookup pool {actual}")]
    WrongPool {
        /// Position's pool.
        expected: Address,
        /// Lookup's pool.
        actual: Address,
    },
    /// A positive position share exceeds its bin's total liquidity.
    #[error("invalid liquidity supply for position bin {bin_id}")]
    InvalidLiquidity {
        /// Affected bin.
        bin_id: i32,
    },
    /// An accumulator moved below its checkpoint; deployed wrap semantics are unproven.
    #[error("fee accumulator moved below its checkpoint for position bin {bin_id}")]
    AccumulatorRewind {
        /// Affected bin.
        bin_id: i32,
    },
    /// A calculation or sum cannot fit in raw units.
    #[error(transparent)]
    Amount(#[from] AmountError),
}

/// Floors each bin's liquidity entitlement and unsettled fees before summing raw amounts.
///
/// Already pending fees are retained even for zero shares or unavailable arrays. Only arrays
/// needed by positive shares affect completeness. Accumulator subtraction is checked: the
/// legacy wrap formula and current SDK subtraction disagree at that boundary, so this function
/// refuses a rewind until the deployed program's semantics are established.
///
/// # Errors
/// Refuses pool mismatches, shares exceeding supply, accumulator rewinds and amount overflow.
pub fn position_amounts(
    position: &PositionV2,
    bins: &BinLookup,
) -> Result<PositionAmounts, PositionValueError> {
    if position.lb_pair != bins.lb_pair() {
        return Err(PositionValueError::WrongPool {
            expected: position.lb_pair,
            actual: bins.lb_pair(),
        });
    }
    let mut totals = PositionAmounts {
        amount_x: RawTokenAmount::ZERO,
        amount_y: RawTokenAmount::ZERO,
        fee_x: RawTokenAmount::ZERO,
        fee_y: RawTokenAmount::ZERO,
        is_complete: true,
    };
    for (bin_id, entitlement) in
        (position.lower_bin_id()..=position.upper_bin_id()).zip(position.bins())
    {
        totals.accrue_bin(bin_id, entitlement, bins.bin(bin_id))?;
    }
    Ok(totals)
}

impl PositionAmounts {
    fn accrue_bin(
        &mut self,
        bin_id: i32,
        entitlement: &PositionBin,
        bin: Option<&Bin>,
    ) -> Result<(), PositionValueError> {
        self.fee_x = self.fee_x.try_add(entitlement.fees.pending_x)?;
        self.fee_y = self.fee_y.try_add(entitlement.fees.pending_y)?;
        let share = entitlement.liquidity_share;
        if share == 0 {
            return Ok(());
        }
        let Some(bin) = bin else {
            self.is_complete = false;
            return Ok(());
        };
        let supply = bin.liquidity_supply;
        let amount_x = proportional_amount(bin.amount_x, share, supply)
            .ok_or(PositionValueError::InvalidLiquidity { bin_id })?;
        let amount_y = proportional_amount(bin.amount_y, share, supply)
            .ok_or(PositionValueError::InvalidLiquidity { bin_id })?;
        self.amount_x = self.amount_x.try_add(amount_x)?;
        self.amount_y = self.amount_y.try_add(amount_y)?;
        self.fee_x = self.fee_x.try_add(unsettled_fee(
            bin_id,
            share,
            bin.fee_x_per_token,
            entitlement.fees.complete_x,
        )?)?;
        self.fee_y = self.fee_y.try_add(unsettled_fee(
            bin_id,
            share,
            bin.fee_y_per_token,
            entitlement.fees.complete_y,
        )?)?;
        Ok(())
    }
}

fn unsettled_fee(
    bin_id: i32,
    share: u128,
    accumulator: u128,
    checkpoint: u128,
) -> Result<RawTokenAmount, PositionValueError> {
    let delta = accumulator
        .checked_sub(checkpoint)
        .ok_or(PositionValueError::AccumulatorRewind { bin_id })?;
    mul_shr_64(share >> FRACTION_BITS, Q64x64(delta))
        .map(RawTokenAmount)
        .ok_or_else(|| AmountError::Overflow.into())
}
