//! Signed amounts: a SOL delta in lamports and a US dollar amount in micro-dollars.
//!
//! A gain, a loss or a cash flow can be negative, so these units wrap an `i128`. Like the unsigned
//! units, they only offer checked arithmetic: an overflow is an error, never a wrap.

use std::fmt;

use crate::error::AmountError;
use crate::units::Lamports;

/// A signed amount of SOL in lamports: a gain, a loss or a net flow.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct SignedLamports(pub i128);

/// A signed amount of US dollars in micro-dollars (10^-6 USD), the scale of USDC and USDT.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct UsdMicros(pub i128);

impl SignedLamports {
    /// Zero lamports.
    pub const ZERO: Self = Self(0);

    /// Adds two amounts.
    ///
    /// # Errors
    ///
    /// Returns [`AmountError::Overflow`] if the sum does not fit in an `i128`.
    pub fn try_add(self, other: Self) -> Result<Self, AmountError> {
        checked(self.0.checked_add(other.0)).map(Self)
    }

    /// Subtracts `other` from this amount.
    ///
    /// # Errors
    ///
    /// Returns [`AmountError::Overflow`] if the difference does not fit in an `i128`.
    pub fn try_sub(self, other: Self) -> Result<Self, AmountError> {
        checked(self.0.checked_sub(other.0)).map(Self)
    }

    /// The opposite amount.
    ///
    /// # Errors
    ///
    /// Returns [`AmountError::Overflow`] for `i128::MIN`, whose opposite does not fit.
    pub fn try_neg(self) -> Result<Self, AmountError> {
        checked(self.0.checked_neg()).map(Self)
    }
}

impl UsdMicros {
    /// Zero dollars.
    pub const ZERO: Self = Self(0);

    /// Adds two amounts.
    ///
    /// # Errors
    ///
    /// Returns [`AmountError::Overflow`] if the sum does not fit in an `i128`.
    pub fn try_add(self, other: Self) -> Result<Self, AmountError> {
        checked(self.0.checked_add(other.0)).map(Self)
    }

    /// Subtracts `other` from this amount.
    ///
    /// # Errors
    ///
    /// Returns [`AmountError::Overflow`] if the difference does not fit in an `i128`.
    pub fn try_sub(self, other: Self) -> Result<Self, AmountError> {
        checked(self.0.checked_sub(other.0)).map(Self)
    }

    /// The opposite amount.
    ///
    /// # Errors
    ///
    /// Returns [`AmountError::Overflow`] for `i128::MIN`, whose opposite does not fit.
    pub fn try_neg(self) -> Result<Self, AmountError> {
        checked(self.0.checked_neg()).map(Self)
    }
}

impl From<Lamports> for SignedLamports {
    fn from(amount: Lamports) -> Self {
        Self(i128::from(amount.0))
    }
}

impl fmt::Display for SignedLamports {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{} lamports", self.0)
    }
}

impl fmt::Display for UsdMicros {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{} micro-dollars", self.0)
    }
}

/// Maps a failed checked operation to the amount error it means.
fn checked(result: Option<i128>) -> Result<i128, AmountError> {
    result.ok_or(AmountError::Overflow)
}

#[cfg(test)]
mod tests {
    use proptest::prelude::*;

    use super::*;

    #[test]
    fn widens_unsigned_lamports_without_loss() {
        assert_eq!(
            SignedLamports::from(Lamports(u64::MAX)),
            SignedLamports(i128::from(u64::MAX))
        );
    }

    #[test]
    fn reports_overflow_at_both_ends_of_the_range() {
        assert_eq!(
            SignedLamports(i128::MAX).try_add(SignedLamports(1)),
            Err(AmountError::Overflow)
        );
        assert_eq!(
            UsdMicros(i128::MIN).try_sub(UsdMicros(1)),
            Err(AmountError::Overflow)
        );
        assert_eq!(
            SignedLamports(i128::MIN).try_neg(),
            Err(AmountError::Overflow)
        );
    }

    #[test]
    fn displays_each_unit_with_its_name() {
        assert_eq!(SignedLamports(-5).to_string(), "-5 lamports");
        assert_eq!(UsdMicros(7).to_string(), "7 micro-dollars");
    }

    proptest! {
        #[test]
        fn subtraction_undoes_addition(a: i64, b: i64) {
            let (a, b) = (SignedLamports(i128::from(a)), SignedLamports(i128::from(b)));
            prop_assert_eq!(a.try_add(b).and_then(|sum| sum.try_sub(b)), Ok(a));
            let (a, b) = (UsdMicros(a.0), UsdMicros(b.0));
            prop_assert_eq!(a.try_add(b).and_then(|sum| sum.try_sub(b)), Ok(a));
        }

        #[test]
        fn negation_is_its_own_inverse(a: i64) {
            let amount = SignedLamports(i128::from(a));
            prop_assert_eq!(amount.try_neg().and_then(SignedLamports::try_neg), Ok(amount));
        }
    }
}
