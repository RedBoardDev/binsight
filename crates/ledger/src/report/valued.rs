//! Amounts valued in SOL and in US dollars, and the choice of the currency shown.
//!
//! SOL is binsight's native unit; dollars are derived once per leaf (a position, an entry, a
//! part of the net worth), at the rate of the leaf, and totals are sums of leaves. A [`Valued`]
//! carries both, so a total is exact in both currencies; [`resolve`] then picks the one the owner
//! asked for. A missing rate makes the dollar side unavailable, never zero.

use binsight_core::decimal::format_signed_units;
use binsight_core::error::AmountError;
use binsight_core::exactness::Exactness;
use binsight_core::money::{SignedLamports, SolUsdRate, UsdMicros};
use binsight_core::ratio::{Percent, RatioError};
use binsight_core::units::Decimals;

use super::figure::{Combination, Figure, Reason, sum_figures};
use crate::facts::{QuoteAsset, QuoteUnits};

/// The currency figures are shown in.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Currency {
    /// SOL, the native unit.
    Sol,
    /// US dollars, derived from SOL at the rate of each leaf.
    Usd,
}

/// The unit of an amount of money.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum MoneyUnit {
    /// SOL, counted in lamports.
    Sol,
    /// US dollars, counted in micro-dollars.
    Usd,
    /// USD Coin, counted in its raw units (micro-dollars).
    Usdc,
    /// Tether USD, counted in its raw units (micro-dollars).
    Usdt,
}

impl MoneyUnit {
    /// The decimals of the unit's raw amounts.
    pub fn decimals(self) -> Decimals {
        match self {
            Self::Sol => Decimals::SOL,
            Self::Usd | Self::Usdc | Self::Usdt => Decimals(6),
        }
    }
}

/// An exact amount of money in one unit.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct Money {
    /// The amount in the unit's raw units (lamports, micro-dollars).
    pub raw: i128,
    /// The unit.
    pub unit: MoneyUnit,
}

impl Money {
    /// The amount as a canonical decimal string in whole units: `"-1.25"`.
    pub fn to_decimal_string(self) -> String {
        format_signed_units(self.raw, self.unit.decimals())
    }
}

/// An amount valued in SOL, and in dollars when a rate is known.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash)]
pub struct Valued {
    /// The SOL value.
    pub sol: SignedLamports,
    /// The dollar value; `None` when no rate is known for the leaf.
    pub usd: Option<UsdMicros>,
}

impl Valued {
    /// Zero in both currencies.
    pub const ZERO: Self = Self {
        sol: SignedLamports::ZERO,
        usd: Some(UsdMicros::ZERO),
    };

    /// A SOL amount, converted to dollars at `rate` when it is known.
    ///
    /// # Errors
    ///
    /// Returns [`AmountError::Overflow`] when the conversion overflows.
    pub fn of_sol(amount: SignedLamports, rate: Option<SolUsdRate>) -> Result<Self, AmountError> {
        let usd = rate.map(|rate| rate.to_usd(amount)).transpose()?;
        Ok(Self { sol: amount, usd })
    }

    /// Adds two valued amounts; the dollar side is known only when both are.
    ///
    /// # Errors
    ///
    /// Returns [`AmountError::Overflow`] when a sum overflows.
    pub fn try_add(self, other: Self) -> Result<Self, AmountError> {
        Ok(Self {
            sol: self.sol.try_add(other.sol)?,
            usd: both(self.usd, other.usd, UsdMicros::try_add)?,
        })
    }

    /// Subtracts `other`; the dollar side is known only when both are.
    ///
    /// # Errors
    ///
    /// Returns [`AmountError::Overflow`] when a difference overflows.
    pub fn try_sub(self, other: Self) -> Result<Self, AmountError> {
        Ok(Self {
            sol: self.sol.try_sub(other.sol)?,
            usd: both(self.usd, other.usd, UsdMicros::try_sub)?,
        })
    }

    /// The amount in `currency`, or `None` for dollars without a rate.
    pub fn in_currency(self, currency: Currency) -> Option<Money> {
        match currency {
            Currency::Sol => Some(Money {
                raw: self.sol.0,
                unit: MoneyUnit::Sol,
            }),
            Currency::Usd => self.usd.map(|usd| Money {
                raw: usd.0,
                unit: MoneyUnit::Usd,
            }),
        }
    }
}

/// Values an amount of a pool's quote token at `rate` (the rate of the leaf's day, or the spot
/// rate for a live figure).
///
/// A SOL amount needs the rate for its dollar side only; a stablecoin amount is its dollar value
/// and needs the rate for its SOL side, so without a rate it is unavailable.
///
/// # Errors
///
/// Returns [`AmountError::Overflow`] when the conversion overflows.
pub fn value_quote(
    amount: QuoteUnits,
    asset: QuoteAsset,
    rate: Option<SolUsdRate>,
) -> Result<Figure<Valued>, AmountError> {
    match asset {
        QuoteAsset::Sol => Valued::of_sol(SignedLamports(amount.0), rate).map(Figure::Complete),
        QuoteAsset::Usdc | QuoteAsset::Usdt => {
            let Some(rate) = rate else {
                return Ok(Figure::unavailable(Reason::NoUsdRate));
            };
            let usd = UsdMicros(amount.0);
            Ok(Figure::Complete(Valued {
                sol: rate.to_sol(usd)?,
                usd: Some(usd),
            }))
        }
    }
}

/// Sums valued figures.
///
/// # Errors
///
/// Returns [`AmountError::Overflow`] when a sum overflows.
pub fn sum_valued(
    figures: impl IntoIterator<Item = Figure<Valued>>,
) -> Result<Figure<Valued>, AmountError> {
    sum_figures(figures, Valued::ZERO, Valued::try_add)
}

/// `left − right` with the exactness rule of a difference.
///
/// # Errors
///
/// Returns [`AmountError::Overflow`] when the difference overflows.
pub fn subtract_valued(
    left: Figure<Valued>,
    right: Figure<Valued>,
) -> Result<Figure<Valued>, AmountError> {
    left.combine(right, Combination::Difference, Valued::try_sub)
}

/// The figure in `currency`; dollars without a rate make it unavailable.
pub fn resolve(figure: &Figure<Valued>, currency: Currency) -> Figure<Money> {
    let exactness = figure.exactness();
    let mut reasons = figure.reasons();
    if let Some(money) = figure
        .value()
        .and_then(|valued| valued.in_currency(currency))
    {
        return Figure::from_parts(money, exactness, reasons);
    }
    if exactness != Exactness::Unavailable {
        reasons.insert(Reason::NoUsdRate);
    }
    Figure::Unavailable { reasons }
}

/// `numerator / denominator` as a percentage, both read in `currency`.
///
/// # Errors
///
/// Returns [`RatioError::Overflow`] when the quotient overflows.
pub fn percent_of(
    numerator: &Figure<Valued>,
    denominator: &Figure<Valued>,
    currency: Currency,
) -> Result<Figure<Percent>, RatioError> {
    let numerator = resolve(numerator, currency);
    let denominator = resolve(denominator, currency);
    numerator.divide(denominator, |top, bottom| Percent::of(top.raw, bottom.raw))
}

/// Applies `operation` when both sides are known.
fn both(
    left: Option<UsdMicros>,
    right: Option<UsdMicros>,
    operation: impl FnOnce(UsdMicros, UsdMicros) -> Result<UsdMicros, AmountError>,
) -> Result<Option<UsdMicros>, AmountError> {
    match (left, right) {
        (Some(left), Some(right)) => operation(left, right).map(Some),
        _ => Ok(None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rate() -> SolUsdRate {
        SolUsdRate::new(200_000_000).unwrap()
    }

    #[test]
    fn values_a_sol_amount_in_both_currencies() {
        let valued = value_quote(QuoteUnits(1_500_000_000), QuoteAsset::Sol, Some(rate())).unwrap();
        let sol = resolve(&valued, Currency::Sol);
        let usd = resolve(&valued, Currency::Usd);
        assert_eq!(sol.value().unwrap().to_decimal_string(), "1.5");
        assert_eq!(usd.value().unwrap().to_decimal_string(), "300");
    }

    #[test]
    fn values_a_stablecoin_amount_at_its_face_value() {
        let valued = value_quote(QuoteUnits(-50_000_000), QuoteAsset::Usdc, Some(rate())).unwrap();
        assert_eq!(
            resolve(&valued, Currency::Usd)
                .value()
                .unwrap()
                .to_decimal_string(),
            "-50"
        );
        assert_eq!(
            resolve(&valued, Currency::Sol)
                .value()
                .unwrap()
                .to_decimal_string(),
            "-0.25"
        );
    }

    #[test]
    fn makes_dollars_without_a_rate_unavailable() {
        let sol_only = value_quote(QuoteUnits(1), QuoteAsset::Sol, None).unwrap();
        assert_eq!(
            resolve(&sol_only, Currency::Usd),
            Figure::unavailable(Reason::NoUsdRate)
        );
        assert_eq!(
            resolve(&sol_only, Currency::Sol).exactness(),
            Exactness::Complete
        );
        let stable = value_quote(QuoteUnits(1), QuoteAsset::Usdt, None).unwrap();
        assert_eq!(stable, Figure::unavailable(Reason::NoUsdRate));
    }

    #[test]
    fn divides_in_the_requested_currency() {
        let gain = Figure::Complete(Valued::of_sol(SignedLamports(1), Some(rate())).unwrap());
        let base = Figure::Complete(Valued::of_sol(SignedLamports(4), Some(rate())).unwrap());
        let percent = percent_of(&gain, &base, Currency::Sol).unwrap();
        assert_eq!(percent, Figure::Complete(Percent(25_000_000)));
    }
}
