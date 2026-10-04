//! The price of one SOL in US dollars, and the exact conversions it allows.
//!
//! A rate is a whole number of micro-dollars per SOL and is never zero, so converting in either
//! direction is always defined. A conversion multiplies, then divides once, rounding half to even
//! to the nearest unit of the target. This module does not know where a rate comes from.

use std::num::NonZeroU64;

use super::signed_units::{SignedLamports, UsdMicros};
use crate::error::AmountError;
use crate::rounding::divide_half_even;

/// Lamports in one SOL.
const LAMPORTS_PER_SOL: i128 = 1_000_000_000;

/// The price of 1 SOL, in micro-dollars (10^-6 USD); never zero.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct SolUsdRate {
    micro_usd_per_sol: NonZeroU64,
}

impl SolUsdRate {
    /// A rate of `micro_usd_per_sol` micro-dollars per SOL, or `None` for zero, which is not a
    /// price.
    pub fn new(micro_usd_per_sol: u64) -> Option<Self> {
        NonZeroU64::new(micro_usd_per_sol).map(|micro_usd_per_sol| Self { micro_usd_per_sol })
    }

    /// Micro-dollars per SOL.
    pub fn micro_usd_per_sol(self) -> u64 {
        self.micro_usd_per_sol.get()
    }

    /// The dollar value of `amount`, rounded half to even to the micro-dollar.
    ///
    /// # Errors
    ///
    /// Returns [`AmountError::Overflow`] if the intermediate product does not fit in an `i128`.
    pub fn to_usd(self, amount: SignedLamports) -> Result<UsdMicros, AmountError> {
        let micro_usd = i128::from(self.micro_usd_per_sol());
        amount
            .0
            .checked_mul(micro_usd)
            .and_then(|product| divide_half_even(product, LAMPORTS_PER_SOL))
            .map(UsdMicros)
            .ok_or(AmountError::Overflow)
    }

    /// The SOL value of `amount`, rounded half to even to the lamport.
    ///
    /// # Errors
    ///
    /// Returns [`AmountError::Overflow`] if the intermediate product does not fit in an `i128`.
    pub fn to_sol(self, amount: UsdMicros) -> Result<SignedLamports, AmountError> {
        let micro_usd = i128::from(self.micro_usd_per_sol());
        amount
            .0
            .checked_mul(LAMPORTS_PER_SOL)
            .and_then(|product| divide_half_even(product, micro_usd))
            .map(SignedLamports)
            .ok_or(AmountError::Overflow)
    }
}

#[cfg(test)]
#[expect(
    clippy::arithmetic_side_effects,
    reason = "the oracles compute in plain integers on inputs bounded far below overflow"
)]
mod tests {
    use proptest::prelude::*;

    use super::*;

    fn rate(micro_usd_per_sol: u64) -> SolUsdRate {
        SolUsdRate::new(micro_usd_per_sol).unwrap()
    }

    #[test]
    fn refuses_a_zero_rate() {
        assert_eq!(SolUsdRate::new(0), None);
    }

    #[test]
    fn converts_whole_sol_at_the_rate() {
        let at_150 = rate(150_000_000);
        assert_eq!(
            at_150.to_usd(SignedLamports(2_000_000_000)),
            Ok(UsdMicros(300_000_000))
        );
        assert_eq!(
            at_150.to_sol(UsdMicros(-75_000_000)),
            Ok(SignedLamports(-500_000_000))
        );
    }

    #[test]
    fn rounds_half_to_even_to_the_target_unit() {
        // 1 lamport at 500 000 micro-dollars per SOL is 0.0005 micro-dollars.
        let at_half = rate(500_000);
        assert_eq!(at_half.to_usd(SignedLamports(1_000)), Ok(UsdMicros(0)));
        assert_eq!(at_half.to_usd(SignedLamports(3_000)), Ok(UsdMicros(2)));
    }

    #[test]
    fn reports_an_overflowing_conversion() {
        assert_eq!(
            rate(u64::MAX).to_usd(SignedLamports(i128::MAX)),
            Err(AmountError::Overflow)
        );
    }

    proptest! {
        #[test]
        fn converts_symmetrically_in_sign(lamports: i64, micro in 1_u64..1_000_000_000_000) {
            let rate = rate(micro);
            let positive = rate.to_usd(SignedLamports(i128::from(lamports))).unwrap();
            let negative = rate.to_usd(SignedLamports(-i128::from(lamports))).unwrap();
            prop_assert_eq!(positive.0, -negative.0);
        }

        #[test]
        fn errs_by_at_most_half_a_micro_dollar(lamports: i64, micro in 1_u64..1_000_000_000_000) {
            let usd = rate(micro).to_usd(SignedLamports(i128::from(lamports))).unwrap();
            // |usd * 10^9 - lamports * rate| <= 10^9 / 2, in integers.
            let exact = i128::from(lamports) * i128::from(micro);
            let error = (usd.0 * LAMPORTS_PER_SOL - exact).abs() * 2;
            prop_assert!(error <= LAMPORTS_PER_SOL);
        }
    }
}
