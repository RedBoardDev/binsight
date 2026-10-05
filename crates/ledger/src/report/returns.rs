//! Returns over time: the daily return of a position and its annualized return.
//!
//! Both scale a position's PnL over what it invested by the time it was held: a position held
//! for less than an hour counts as held for an hour, so a quick trade does not show an absurd
//! daily rate, and an annualized return is only given after a full day.

use binsight_core::ratio::{Percent, RatioError};

use super::figure::Figure;
use super::valued::{Currency, Valued, resolve};

/// Seconds in a day.
const SECONDS_PER_DAY: i128 = 86_400;

/// Seconds in a (365-day) year.
const SECONDS_PER_YEAR: i128 = 31_536_000;

/// The shortest holding time a return is computed over.
const MINIMUM_HELD_SECONDS: i128 = 3_600;

/// The PnL per day held, as a percentage of `invested`, in `currency`.
///
/// # Errors
///
/// Returns [`RatioError::Overflow`] when the quotient overflows.
pub fn daily_return(
    pnl: &Figure<Valued>,
    invested: &Figure<Valued>,
    held_seconds: i64,
    currency: Currency,
) -> Result<Figure<Percent>, RatioError> {
    scaled_return(pnl, invested, held_seconds, SECONDS_PER_DAY, currency)
}

/// The PnL per year held, as a percentage of `invested`, in `currency`; `None` before the
/// position has been held a full day.
///
/// # Errors
///
/// Returns [`RatioError::Overflow`] when the quotient overflows.
pub fn annual_return(
    pnl: &Figure<Valued>,
    invested: &Figure<Valued>,
    held_seconds: i64,
    currency: Currency,
) -> Result<Option<Figure<Percent>>, RatioError> {
    if i128::from(held_seconds) < SECONDS_PER_DAY {
        return Ok(None);
    }
    scaled_return(pnl, invested, held_seconds, SECONDS_PER_YEAR, currency).map(Some)
}

/// `pnl / invested × period / held`, as a percentage.
fn scaled_return(
    pnl: &Figure<Valued>,
    invested: &Figure<Valued>,
    held_seconds: i64,
    period_seconds: i128,
    currency: Currency,
) -> Result<Figure<Percent>, RatioError> {
    let held = i128::from(held_seconds).max(MINIMUM_HELD_SECONDS);
    resolve(pnl, currency).divide(resolve(invested, currency), |pnl, invested| {
        let numerator = pnl
            .raw
            .checked_mul(period_seconds)
            .ok_or(RatioError::Overflow)?;
        let denominator = invested.raw.checked_mul(held).ok_or(RatioError::Overflow)?;
        Percent::of(numerator, denominator)
    })
}

#[cfg(test)]
mod tests {
    use binsight_core::money::SignedLamports;

    use super::*;

    fn sol(amount: i128) -> Figure<Valued> {
        Figure::Complete(Valued::of_sol(SignedLamports(amount), None).unwrap())
    }

    #[test]
    fn scales_the_return_to_one_day() {
        // +2 % over two days is +1 % a day.
        let daily = daily_return(&sol(2), &sol(100), 172_800, Currency::Sol).unwrap();
        assert_eq!(daily, Figure::Complete(Percent(1_000_000)));
    }

    #[test]
    fn counts_a_short_holding_as_one_hour() {
        let daily = daily_return(&sol(1), &sol(100), 60, Currency::Sol).unwrap();
        assert_eq!(daily, Figure::Complete(Percent(24_000_000)));
    }

    #[test]
    fn gives_an_annual_return_only_after_a_full_day() {
        assert_eq!(
            annual_return(&sol(1), &sol(100), 86_399, Currency::Sol).unwrap(),
            None
        );
        let annual = annual_return(&sol(1), &sol(100), 86_400, Currency::Sol).unwrap();
        assert_eq!(annual, Some(Figure::Complete(Percent(365_000_000))));
    }
}
