//! Reconstructs a wallet point while keeping capital, realized PnL and mark quality independent.

use binsight_core::error::AmountError;
use binsight_core::money::SignedLamports;

use crate::facts::DailyRate;
use crate::report::figure::{Combination, Figure, Reason};
use crate::report::valued::Valued;

pub(super) fn reconstruct(
    capital: &Figure<Valued>,
    realized: Figure<Valued>,
    open_pnl: Figure<SignedLamports>,
    rate: Option<DailyRate>,
) -> Result<Figure<(Valued, Valued)>, AmountError> {
    let realized = realized.combine(open_pnl, Combination::Sum, |mut realized, open| {
        realized.sol = realized.sol.map(|sol| sol.try_add(open)).transpose()?;
        Ok::<_, AmountError>(realized)
    })?;
    let both = realized.combine(capital.clone(), Combination::Sum, |realized, capital| {
        reconstruct_values(realized, capital, rate)
    })?;
    if both.value().is_some_and(|(_, worth)| worth.sol.is_none()) {
        let mut reasons = both.reasons();
        reasons.insert(Reason::NoUsdRate);
        return Ok(Figure::Unavailable { reasons });
    }
    Ok(both)
}

fn reconstruct_values(
    realized: Valued,
    capital: Valued,
    rate: Option<DailyRate>,
) -> Result<(Valued, Valued), AmountError> {
    let mut worth = match (capital.sol, realized.sol) {
        (Some(capital), Some(pnl)) => Valued::of_sol_at(capital.try_add(pnl)?, rate)?,
        _ => Valued {
            sol: None,
            usd: None,
            provisional_sol: None,
            provisional_usd: None,
        },
    };
    worth.provisional_sol = capital
        .provisional_sol
        .into_iter()
        .chain(realized.provisional_sol)
        .min();
    worth.provisional_usd = worth
        .provisional_usd
        .into_iter()
        .chain(worth.provisional_sol)
        .min();
    let pnl = Valued {
        sol: realized.sol,
        usd: match (worth.usd, capital.usd) {
            (Some(worth), Some(capital)) => Some(worth.try_sub(capital)?),
            _ => None,
        },
        provisional_sol: realized.provisional_sol,
        provisional_usd: worth
            .provisional_usd
            .into_iter()
            .chain(capital.provisional_usd)
            .min(),
    };
    Ok((pnl, worth))
}
