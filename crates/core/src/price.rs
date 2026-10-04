//! A unit price: how many quote tokens one whole base token is worth.
//!
//! Prices are fixed-point integers with 18 decimals, so a token worth a ten-millionth of a SOL
//! still keeps eleven significant digits. They are shown with twelve significant digits, rounded
//! half to even, never in exponent notation. Prices only describe; amounts are valued elsewhere
//! with the exact rule of their source (for DLMM, the bin price of the program).

use std::fmt;

use crate::decimal::format_units;
use crate::rounding::divide_half_even_unsigned;
use crate::units::{Decimals, RawTokenAmount};

/// The number of decimals of the fixed-point value of a [`Price`].
pub const PRICE_DECIMALS: Decimals = Decimals(18);

/// How many significant digits a price keeps when it is shown.
const SIGNIFICANT_DIGITS: u32 = 12;

/// Whole quote tokens per whole base token, in units of 10^-18.
///
/// `Price(1_500_000_000_000_000_000)` means one base token is worth 1.5 quote tokens.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Price(pub u128);

impl Price {
    /// The price as a canonical decimal string with at most twelve significant digits, rounded
    /// half to even: `"0.000000123456789012"`, `"152.25"`.
    ///
    /// In the only case where rounding up would overflow (a price within 10^-12 of the largest
    /// value), the digits are truncated instead.
    pub fn to_significant_string(self) -> String {
        let digits = self
            .0
            .checked_ilog10()
            .map_or(1, |log| log.saturating_add(1));
        let dropped = digits.saturating_sub(SIGNIFICANT_DIGITS);
        // `digits <= 39`, so `dropped <= 27` and the power of ten always fits.
        let unit = 10_u128.checked_pow(dropped).unwrap_or(1);
        let rounded =
            divide_half_even_unsigned(self.0, unit).and_then(|kept| kept.checked_mul(unit));
        let truncated = self
            .0
            .checked_div(unit)
            .and_then(|kept| kept.checked_mul(unit));
        let shown = rounded.or(truncated).unwrap_or(self.0);
        format_units(RawTokenAmount(shown), PRICE_DECIMALS)
    }
}

impl fmt::Display for Price {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.to_significant_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_short_prices_whole() {
        assert_eq!(Price(0).to_significant_string(), "0");
        assert_eq!(
            Price(152_250_000_000_000_000_000).to_significant_string(),
            "152.25"
        );
        assert_eq!(Price(120_000_000_000).to_significant_string(), "0.00000012");
    }

    #[test]
    fn rounds_to_twelve_significant_digits_half_to_even() {
        assert_eq!(
            Price(1_234_567_890_123_456_789).to_significant_string(),
            "1.23456789012"
        );
        assert_eq!(
            Price(1_000_000_000_005_000_000).to_significant_string(),
            "1"
        );
        assert_eq!(
            Price(1_000_000_000_015_000_000).to_significant_string(),
            "1.00000000002"
        );
        assert_eq!(Price(999_999_999_999_600_000).to_significant_string(), "1");
    }

    #[test]
    fn never_writes_an_exponent() {
        let text = Price(u128::MAX).to_significant_string();
        assert!(!text.contains('e'), "{text}");
        assert_eq!(text, "340282366920000000000");
        assert_eq!(Price(1).to_string(), "0.000000000000000001");
    }
}
