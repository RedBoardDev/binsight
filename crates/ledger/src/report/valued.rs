//! Amounts valued in SOL and in US dollars, and the choice of the currency shown.
//!
//! Each leaf retains its native SOL or dollar value independently of conversion. Totals add
//! each currency separately; [`resolve`] picks the requested currency and applies the quality
//! of its conversion. A missing rate makes only the converted side unavailable, never zero.

use binsight_core::decimal::format_signed_units;
use binsight_core::error::AmountError;
use binsight_core::exactness::Exactness;
use binsight_core::money::{SignedLamports, SolUsdRate, UsdMicros};
use binsight_core::ratio::{Percent, RatioError};
use binsight_core::units::Decimals;

use super::figure::{Combination, Figure, Reason, Reasons, sum_figures};
use crate::facts::{DailyRate, QuoteAsset, QuoteUnits};
use jiff::civil::Date;

/// The currency figures are shown in.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Currency {
    /// SOL, the native unit.
    Sol,
    /// US dollars, native for dollar stablecoins or converted at each leaf’s rate.
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

/// Independent SOL and dollar sides, with the quality of their conversions.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash)]
pub struct Valued {
    /// The SOL value; absent when a dollar-native leaf has no conversion rate.
    pub sol: Option<SignedLamports>,
    /// The dollar value; `None` when no rate is known for the leaf.
    pub usd: Option<UsdMicros>,
    /// UTC day whose provisional conversion affects the SOL side.
    pub provisional_sol: Option<Date>,
    /// UTC day whose provisional conversion affects the USD side.
    pub provisional_usd: Option<Date>,
}

impl Valued {
    /// Zero in both currencies.
    pub const ZERO: Self = Self {
        sol: Some(SignedLamports::ZERO),
        usd: Some(UsdMicros::ZERO),
        provisional_sol: None,
        provisional_usd: None,
    };

    /// A SOL amount, converted to dollars at `rate` when it is known.
    ///
    /// # Errors
    ///
    /// Returns [`AmountError::Overflow`] when the conversion overflows.
    pub fn of_sol(amount: SignedLamports, rate: Option<SolUsdRate>) -> Result<Self, AmountError> {
        if amount == SignedLamports::ZERO {
            return Ok(Self::ZERO);
        }
        let usd = rate.map(|rate| rate.to_usd(amount)).transpose()?;
        Ok(Self {
            sol: Some(amount),
            usd,
            provisional_sol: None,
            provisional_usd: None,
        })
    }

    /// Adds each currency independently; a side is known only when both are.
    ///
    /// # Errors
    ///
    /// Returns [`AmountError::Overflow`] when a sum overflows.
    pub fn try_add(self, other: Self) -> Result<Self, AmountError> {
        Ok(Self {
            sol: both(self.sol, other.sol, SignedLamports::try_add)?,
            usd: both(self.usd, other.usd, UsdMicros::try_add)?,
            provisional_sol: earlier_day(self.provisional_sol, other.provisional_sol),
            provisional_usd: earlier_day(self.provisional_usd, other.provisional_usd),
        })
    }

    /// Subtracts each currency independently; a side is known only when both are.
    ///
    /// # Errors
    ///
    /// Returns [`AmountError::Overflow`] when a difference overflows.
    pub fn try_sub(self, other: Self) -> Result<Self, AmountError> {
        Ok(Self {
            sol: both(self.sol, other.sol, SignedLamports::try_sub)?,
            usd: both(self.usd, other.usd, UsdMicros::try_sub)?,
            provisional_sol: earlier_day(self.provisional_sol, other.provisional_sol),
            provisional_usd: earlier_day(self.provisional_usd, other.provisional_usd),
        })
    }

    /// The amount in `currency`, absent when that side requires a missing rate.
    pub fn in_currency(self, currency: Currency) -> Option<Money> {
        match currency {
            Currency::Sol => self.sol.map(|sol| Money {
                raw: sol.0,
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
/// and needs the rate only for its SOL side.
///
/// # Errors
///
/// Returns [`AmountError::Overflow`] when the conversion overflows.
pub fn value_quote(
    amount: QuoteUnits,
    asset: QuoteAsset,
    rate: Option<SolUsdRate>,
) -> Result<Figure<Valued>, AmountError> {
    if amount.0 == 0 {
        return Ok(Figure::Complete(Valued::ZERO));
    }
    match asset {
        QuoteAsset::Sol => Valued::of_sol(SignedLamports(amount.0), rate).map(Figure::Complete),
        QuoteAsset::Usdc | QuoteAsset::Usdt => {
            let usd = UsdMicros(amount.0);
            Ok(Figure::Complete(Valued {
                sol: rate.map(|rate| rate.to_sol(usd)).transpose()?,
                usd: Some(usd),
                provisional_sol: None,
                provisional_usd: None,
            }))
        }
    }
}

/// A historical quote amount converted with its day's quality. Native currency stays exact.
///
/// # Errors
/// Returns [`AmountError::Overflow`] when the conversion overflows.
pub fn value_quote_at(
    amount: QuoteUnits,
    asset: QuoteAsset,
    rate: Option<DailyRate>,
) -> Result<Figure<Valued>, AmountError> {
    let day = rate
        .and_then(DailyRate::provisional_day)
        .filter(|_| amount.0 != 0);
    value_quote(amount, asset, rate.map(DailyRate::value)).map(|figure| {
        figure.map(|mut value| {
            match asset {
                QuoteAsset::Sol => value.provisional_usd = day,
                QuoteAsset::Usdc | QuoteAsset::Usdt => value.provisional_sol = day,
            }
            value
        })
    })
}

impl Valued {
    /// A historical native SOL amount, with estimation only on its USD conversion.
    ///
    /// # Errors
    /// Returns [`AmountError::Overflow`] when the conversion overflows.
    pub fn of_sol_at(amount: SignedLamports, rate: Option<DailyRate>) -> Result<Self, AmountError> {
        let mut value = Self::of_sol(amount, rate.map(DailyRate::value))?;
        value.provisional_usd = rate
            .and_then(DailyRate::provisional_day)
            .filter(|_| amount != SignedLamports::ZERO);
        Ok(value)
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

/// The figure in `currency`; missing conversions are unavailable and provisional ones estimated.
pub fn resolve(figure: &Figure<Valued>, currency: Currency) -> Figure<Money> {
    let exactness = figure.exactness();
    let mut reasons = figure.reasons();
    if let Some(money) = figure
        .value()
        .and_then(|valued| valued.in_currency(currency))
    {
        let resolved = Figure::from_parts(money, exactness, reasons);
        let day = figure.value().and_then(|value| match currency {
            Currency::Sol => value.provisional_sol,
            Currency::Usd => value.provisional_usd,
        });
        return match day {
            Some(day) => resolved.degraded(
                Exactness::Estimated,
                Reasons::from([Reason::ProvisionalRate { day }]),
            ),
            None => resolved,
        };
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

fn earlier_day(left: Option<Date>, right: Option<Date>) -> Option<Date> {
    left.into_iter().chain(right).min()
}

/// Applies `operation` when both sides are known.
fn both<T>(
    left: Option<T>,
    right: Option<T>,
    operation: impl FnOnce(T, T) -> Result<T, AmountError>,
) -> Result<Option<T>, AmountError> {
    match (left, right) {
        (Some(left), Some(right)) => operation(left, right).map(Some),
        _ => Ok(None),
    }
}

#[cfg(test)]
#[path = "valued/tests.rs"]
mod tests;
