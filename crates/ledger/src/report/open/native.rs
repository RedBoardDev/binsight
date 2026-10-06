//! Native open-position fees and PnL combine source figures before one currency conversion.
//!
//! All operands belong to the same position and selected quote; this module does not mix
//! pool assets, apply FX or decide whether a raw account observation is complete.

use binsight_core::error::AmountError;
use binsight_core::exactness::Exactness;

use crate::facts::{OpenPositionFacts, QuoteUnits};
use crate::report::figure::{Combination, Figure, Reason, Reasons};

/// withdrawn + claimed fees + rewards + value + unclaimed fees − invested, in the quote token.
///
/// # Errors
///
/// Returns [`AmountError::Overflow`] when the sum overflows.
pub fn open_pnl(position: &OpenPositionFacts) -> Result<Figure<QuoteUnits>, AmountError> {
    let returned = Figure::Complete(native_sum(
        &[position.withdrawn, position.claimed_fees, position.rewards],
        &[],
    )?)
    .combine(position.value.clone(), Combination::Sum, add_native)?
    .combine(
        position.unclaimed_fees.clone(),
        Combination::Sum,
        add_native,
    )?;
    let pnl = returned.combine(
        Figure::Complete(position.invested),
        Combination::Difference,
        |returned, invested| native_sum(&[returned], &[invested]),
    )?;
    if position.unpriced_movements == 0
        && position.unpriced_rebalances == 0
        && position.unpriced_rewards == 0
    {
        return Ok(pnl);
    }
    Ok(pnl.degraded(
        Exactness::Estimated,
        Reasons::from([Reason::UnpricedLeg {
            position: position.id,
        }]),
    ))
}

/// Claimed and pending fees share one native unit and one eventual conversion boundary.
pub(super) fn native_fees(position: &OpenPositionFacts) -> Result<Figure<QuoteUnits>, AmountError> {
    let claimed = Figure::Complete(position.claimed_fees);
    let claimed = if position.unpriced_movements == 0 {
        claimed
    } else {
        claimed.degraded(
            Exactness::Partial,
            Reasons::from([Reason::UnpricedLeg {
                position: position.id,
            }]),
        )
    };
    claimed.combine(
        position.unclaimed_fees.clone(),
        Combination::Sum,
        add_native,
    )
}

/// `Σ added − Σ removed`, in the quote token.
pub(super) fn native_sum(
    added: &[QuoteUnits],
    removed: &[QuoteUnits],
) -> Result<QuoteUnits, AmountError> {
    let mut total: i128 = 0;
    for amount in added {
        total = total.checked_add(amount.0).ok_or(AmountError::Overflow)?;
    }
    for amount in removed {
        total = total.checked_sub(amount.0).ok_or(AmountError::Overflow)?;
    }
    Ok(QuoteUnits(total))
}

fn add_native(left: QuoteUnits, right: QuoteUnits) -> Result<QuoteUnits, AmountError> {
    native_sum(&[left, right], &[])
}
