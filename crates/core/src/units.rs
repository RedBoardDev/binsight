//! Integer money units: lamports, raw token amounts and token decimals.
//!
//! Every amount in binsight is an unsigned integer in the smallest unit the chain knows, so no
//! rounding can ever happen. This module only offers checked arithmetic (`try_add`, `try_sub`):
//! there is deliberately no `+` or `-` operator and no conversion from floating point. Turning an
//! amount into a human-readable decimal string is the job of [`crate::decimal`].

use std::fmt;

use crate::error::AmountError;

/// An amount of SOL counted in lamports, the smallest SOL unit (1 SOL = 10^9 lamports).
///
/// A `u64` holds every possible on-chain lamport balance.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Lamports(pub u64);

impl Lamports {
    /// Zero lamports.
    pub const ZERO: Self = Self(0);

    /// Adds two amounts.
    ///
    /// # Errors
    ///
    /// Returns [`AmountError::Overflow`] if the sum does not fit in a `u64`.
    pub fn try_add(self, other: Self) -> Result<Self, AmountError> {
        self.0
            .checked_add(other.0)
            .map(Self)
            .ok_or(AmountError::Overflow)
    }

    /// Subtracts `other` from this amount.
    ///
    /// # Errors
    ///
    /// Returns [`AmountError::Negative`] if `other` is larger than this amount: amounts are never
    /// negative.
    pub fn try_sub(self, other: Self) -> Result<Self, AmountError> {
        self.0
            .checked_sub(other.0)
            .map(Self)
            .ok_or(AmountError::Negative)
    }

    /// The same amount as a raw token amount, so SOL can be handled like any other token.
    ///
    /// Lamports are the raw units of SOL, which has [`Decimals::SOL`] decimals. The conversion is
    /// lossless because every `u64` fits in a `u128`.
    pub fn to_raw(self) -> RawTokenAmount {
        RawTokenAmount(u128::from(self.0))
    }
}

impl fmt::Display for Lamports {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{} lamports", self.0)
    }
}

/// An amount of any token counted in its raw on-chain units (before applying its decimals).
///
/// On-chain token amounts are `u64`; a `u128` also holds any sum of them without overflowing in
/// practice.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct RawTokenAmount(pub u128);

impl RawTokenAmount {
    /// Zero raw units.
    pub const ZERO: Self = Self(0);

    /// Adds two amounts.
    ///
    /// # Errors
    ///
    /// Returns [`AmountError::Overflow`] if the sum does not fit in a `u128`.
    pub fn try_add(self, other: Self) -> Result<Self, AmountError> {
        self.0
            .checked_add(other.0)
            .map(Self)
            .ok_or(AmountError::Overflow)
    }

    /// Subtracts `other` from this amount.
    ///
    /// # Errors
    ///
    /// Returns [`AmountError::Negative`] if `other` is larger than this amount: amounts are never
    /// negative.
    pub fn try_sub(self, other: Self) -> Result<Self, AmountError> {
        self.0
            .checked_sub(other.0)
            .map(Self)
            .ok_or(AmountError::Negative)
    }
}

impl fmt::Display for RawTokenAmount {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{} raw units", self.0)
    }
}

/// The number of decimal places of a token: a raw amount of `1` is worth `10^-decimals` tokens.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Decimals(pub u8);

impl Decimals {
    /// The decimals of SOL: 1 SOL is 10^9 lamports.
    pub const SOL: Self = Self(9);
}

impl fmt::Display for Decimals {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{} decimals", self.0)
    }
}

#[cfg(test)]
mod tests {
    use proptest::prelude::*;

    use super::*;

    #[test]
    fn displays_each_unit_with_its_name() {
        assert_eq!(Lamports(123).to_string(), "123 lamports");
        assert_eq!(RawTokenAmount(7).to_string(), "7 raw units");
        assert_eq!(Decimals(6).to_string(), "6 decimals");
    }

    #[test]
    fn reports_overflow_at_the_top_of_the_range() {
        assert_eq!(
            Lamports(u64::MAX).try_add(Lamports(1)),
            Err(AmountError::Overflow)
        );
        assert_eq!(
            RawTokenAmount(u128::MAX).try_add(RawTokenAmount(1)),
            Err(AmountError::Overflow)
        );
    }

    #[test]
    fn refuses_to_go_below_zero() {
        assert_eq!(Lamports(1).try_sub(Lamports(2)), Err(AmountError::Negative));
        assert_eq!(
            RawTokenAmount::ZERO.try_sub(RawTokenAmount(1)),
            Err(AmountError::Negative)
        );
    }

    #[test]
    fn converts_lamports_to_raw_units_without_loss() {
        assert_eq!(
            Lamports(u64::MAX).to_raw(),
            RawTokenAmount(u128::from(u64::MAX))
        );
    }

    proptest! {
        #[test]
        fn raw_addition_is_exact_or_reports_overflow(a: u128, b: u128) {
            match RawTokenAmount(a).try_add(RawTokenAmount(b)) {
                Ok(sum) => {
                    prop_assert!(sum.0 >= a);
                    prop_assert_eq!(sum.try_sub(RawTokenAmount(b)), Ok(RawTokenAmount(a)));
                }
                Err(error) => {
                    prop_assert_eq!(error, AmountError::Overflow);
                    prop_assert!(u128::MAX.checked_sub(a).is_some_and(|room| b > room));
                }
            }
        }

        #[test]
        fn raw_subtraction_never_goes_below_zero(a: u128, b: u128) {
            match RawTokenAmount(a).try_sub(RawTokenAmount(b)) {
                Ok(difference) => {
                    prop_assert!(b <= a);
                    prop_assert_eq!(difference.try_add(RawTokenAmount(b)), Ok(RawTokenAmount(a)));
                }
                Err(error) => {
                    prop_assert_eq!(error, AmountError::Negative);
                    prop_assert!(b > a);
                }
            }
        }

        #[test]
        fn lamport_addition_is_exact_or_reports_overflow(a: u64, b: u64) {
            match Lamports(a).try_add(Lamports(b)) {
                Ok(sum) => prop_assert_eq!(sum.try_sub(Lamports(b)), Ok(Lamports(a))),
                Err(error) => {
                    prop_assert_eq!(error, AmountError::Overflow);
                    prop_assert!(u64::MAX.checked_sub(a).is_some_and(|room| b > room));
                }
            }
        }

        #[test]
        fn lamport_subtraction_never_goes_below_zero(a: u64, b: u64) {
            match Lamports(a).try_sub(Lamports(b)) {
                Ok(difference) => prop_assert_eq!(difference.try_add(Lamports(b)), Ok(Lamports(a))),
                Err(error) => {
                    prop_assert_eq!(error, AmountError::Negative);
                    prop_assert!(b > a);
                }
            }
        }

        #[test]
        fn lamports_and_their_raw_form_agree_on_addition(a: u64, b: u64) {
            let as_lamports = Lamports(a).try_add(Lamports(b)).map(Lamports::to_raw);
            let as_raw = Lamports(a).to_raw().try_add(Lamports(b).to_raw());
            if let Ok(sum) = as_lamports {
                prop_assert_eq!(as_raw, Ok(sum));
            }
        }
    }
}
