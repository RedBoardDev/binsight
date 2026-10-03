//! Exact conversion between raw integer amounts and decimal strings.
//!
//! The API sends every amount as a decimal string, never as a JSON number, so that no client can
//! lose precision. This module writes those strings in one canonical form and reads them back
//! exactly. It works on text only: no floating point is involved, and it does not round, convert
//! between currencies or know about prices.
//!
//! The canonical form matches `^-?(0|[1-9][0-9]*)(\.[0-9]*[1-9])?$`: no leading zeros, no trailing
//! zeros after the decimal point, no exponent, no `+` sign and never `-0`.

use crate::error::DecimalError;
use crate::units::{Decimals, RawTokenAmount};

/// Decimal strings are written in base ten.
const DECIMAL_RADIX: u32 = 10;

/// Writes a raw amount as a canonical decimal string.
///
/// For example, with [`Decimals::SOL`], a raw amount of `1` becomes `"0.000000001"`,
/// `1_500_000_000` becomes `"1.5"` and `0` becomes `"0"`.
pub fn format_units(amount: RawTokenAmount, decimals: Decimals) -> String {
    let places = usize::from(decimals.0);
    let digits = amount.0.to_string();

    // Left-pad with zeros so that at least one digit stays before the decimal point.
    let minimum_width = places.saturating_add(1);
    let padded = format!("{digits:0>minimum_width$}");

    let integer_length = padded.len().saturating_sub(places);
    let integer: String = padded.chars().take(integer_length).collect();
    let fraction: String = padded.chars().skip(integer_length).collect();
    let fraction = fraction.trim_end_matches('0');

    if fraction.is_empty() {
        integer
    } else {
        format!("{integer}.{fraction}")
    }
}

/// Writes a signed raw amount (a gain, a loss, a delta) as a canonical decimal string.
///
/// Negative amounts start with `-`; zero is always `"0"`, never `"-0"`.
pub fn format_signed_units(raw: i128, decimals: Decimals) -> String {
    let magnitude = format_units(RawTokenAmount(raw.unsigned_abs()), decimals);
    if raw < 0 {
        format!("-{magnitude}")
    } else {
        magnitude
    }
}

/// Reads a decimal string as a raw amount of a token with the given decimals.
///
/// Accepts digits with an optional decimal point, such as `"12"`, `"0.5"` or `"1.250"`; leading
/// zeros and trailing zeros after the point are tolerated. Anything ambiguous is refused.
///
/// # Errors
///
/// Returns a [`DecimalError`] when the text is empty, signed, contains anything but digits and one
/// decimal point, has more digits after the point than `decimals`, or does not fit in a `u128`.
pub fn parse_units(text: &str, decimals: Decimals) -> Result<RawTokenAmount, DecimalError> {
    let (integer, fraction) = split_integer_and_fraction(text)?;

    let found = fraction.len();
    if found > usize::from(decimals.0) {
        return Err(DecimalError::TooManyDecimals {
            found,
            allowed: decimals.0,
        });
    }

    let mut value: u128 = 0;
    for character in integer.chars().chain(fraction.chars()) {
        let digit = character
            .to_digit(DECIMAL_RADIX)
            .ok_or(DecimalError::InvalidCharacter(character))?;
        value = append_digit(value, digit)?;
    }
    // Scale the value to raw units for the decimals the text did not write out.
    for _ in found..usize::from(decimals.0) {
        value = append_digit(value, 0)?;
    }
    Ok(RawTokenAmount(value))
}

/// Checks the shape of the text and splits it into the digits before and after the point.
fn split_integer_and_fraction(text: &str) -> Result<(&str, &str), DecimalError> {
    if text.is_empty() {
        return Err(DecimalError::Empty);
    }
    if text.starts_with(['+', '-']) {
        return Err(DecimalError::Signed);
    }
    if let Some(invalid) = text.chars().find(|c| !c.is_ascii_digit() && *c != '.') {
        return Err(DecimalError::InvalidCharacter(invalid));
    }
    match text.split_once('.') {
        None => Ok((text, "")),
        Some((_, fraction)) if fraction.contains('.') => Err(DecimalError::MultiplePoints),
        Some((integer, fraction)) if integer.is_empty() || fraction.is_empty() => {
            Err(DecimalError::MissingDigits)
        }
        Some((integer, fraction)) => Ok((integer, fraction)),
    }
}

/// Returns `value * 10 + digit`: one more decimal digit on the right.
/// Fails with [`DecimalError::TooLarge`] if that overflows a `u128`.
fn append_digit(value: u128, digit: u32) -> Result<u128, DecimalError> {
    value
        .checked_mul(u128::from(DECIMAL_RADIX))
        .and_then(|shifted| shifted.checked_add(u128::from(digit)))
        .ok_or(DecimalError::TooLarge)
}

#[cfg(test)]
mod tests {
    use proptest::prelude::*;

    use super::*;

    /// Hand-written check of `^-?(0|[1-9][0-9]*)(\.[0-9]*[1-9])?$`, without a regex dependency.
    fn is_canonical(text: &str) -> bool {
        let unsigned = text.strip_prefix('-').unwrap_or(text);
        let (integer, fraction) = match unsigned.split_once('.') {
            Some((integer, fraction)) => (integer, Some(fraction)),
            None => (unsigned, None),
        };
        let integer_ok = integer == "0"
            || (!integer.is_empty()
                && !integer.starts_with('0')
                && integer.chars().all(|c| c.is_ascii_digit()));
        let fraction_ok = fraction.is_none_or(|fraction| {
            !fraction.is_empty()
                && fraction.chars().all(|c| c.is_ascii_digit())
                && !fraction.ends_with('0')
        });
        let not_negative_zero = text != "-0";
        integer_ok && fraction_ok && not_negative_zero
    }

    #[test]
    fn formats_the_named_cases() {
        assert_eq!(format_units(RawTokenAmount(0), Decimals::SOL), "0");
        assert_eq!(
            format_units(RawTokenAmount(1), Decimals::SOL),
            "0.000000001"
        );
        assert_eq!(
            format_units(RawTokenAmount(1_000_000_000), Decimals::SOL),
            "1"
        );
        assert_eq!(
            format_units(RawTokenAmount(1_500_000_000), Decimals::SOL),
            "1.5"
        );
        assert_eq!(format_units(RawTokenAmount(120), Decimals(0)), "120");
        assert_eq!(
            format_units(RawTokenAmount(u128::MAX), Decimals(0)),
            "340282366920938463463374607431768211455"
        );
        assert_eq!(
            format_units(RawTokenAmount(u128::MAX), Decimals(38)),
            "3.40282366920938463463374607431768211455"
        );
        assert_eq!(
            format_units(RawTokenAmount(u128::MAX), Decimals(39)),
            "0.340282366920938463463374607431768211455"
        );
    }

    #[test]
    fn formats_signed_amounts_without_negative_zero() {
        assert_eq!(format_signed_units(0, Decimals::SOL), "0");
        assert_eq!(format_signed_units(-1, Decimals::SOL), "-0.000000001");
        assert_eq!(format_signed_units(2_500_000_000, Decimals::SOL), "2.5");
        assert_eq!(
            format_signed_units(i128::MIN, Decimals(0)),
            "-170141183460469231731687303715884105728"
        );
    }

    #[test]
    fn parses_the_named_cases() {
        assert_eq!(parse_units("0", Decimals::SOL), Ok(RawTokenAmount(0)));
        assert_eq!(
            parse_units("1", Decimals::SOL),
            Ok(RawTokenAmount(1_000_000_000))
        );
        assert_eq!(
            parse_units("0.000000001", Decimals::SOL),
            Ok(RawTokenAmount(1))
        );
        assert_eq!(
            parse_units("1.5", Decimals::SOL),
            Ok(RawTokenAmount(1_500_000_000))
        );
        assert_eq!(
            parse_units("1.50", Decimals::SOL),
            Ok(RawTokenAmount(1_500_000_000))
        );
        assert_eq!(parse_units("007", Decimals(0)), Ok(RawTokenAmount(7)));
        assert_eq!(
            parse_units("340282366920938463463374607431768211455", Decimals(0)),
            Ok(RawTokenAmount(u128::MAX))
        );
    }

    #[test]
    fn refuses_ambiguous_or_invalid_text() {
        assert_eq!(parse_units("", Decimals::SOL), Err(DecimalError::Empty));
        assert_eq!(parse_units("+1", Decimals::SOL), Err(DecimalError::Signed));
        assert_eq!(parse_units("-1", Decimals::SOL), Err(DecimalError::Signed));
        assert_eq!(
            parse_units("1e9", Decimals::SOL),
            Err(DecimalError::InvalidCharacter('e'))
        );
        assert_eq!(
            parse_units(" 1", Decimals::SOL),
            Err(DecimalError::InvalidCharacter(' '))
        );
        assert_eq!(
            parse_units("1,5", Decimals::SOL),
            Err(DecimalError::InvalidCharacter(','))
        );
        assert_eq!(
            parse_units("1.2.3", Decimals::SOL),
            Err(DecimalError::MultiplePoints)
        );
        assert_eq!(
            parse_units(".5", Decimals::SOL),
            Err(DecimalError::MissingDigits)
        );
        assert_eq!(
            parse_units("1.", Decimals::SOL),
            Err(DecimalError::MissingDigits)
        );
    }

    #[test]
    fn refuses_more_decimals_than_the_token_has() {
        assert_eq!(
            parse_units("0.0000000001", Decimals::SOL),
            Err(DecimalError::TooManyDecimals {
                found: 10,
                allowed: 9
            })
        );
        assert_eq!(
            parse_units("1.0", Decimals(0)),
            Err(DecimalError::TooManyDecimals {
                found: 1,
                allowed: 0
            })
        );
    }

    #[test]
    fn refuses_amounts_beyond_u128() {
        assert_eq!(
            parse_units("340282366920938463463374607431768211456", Decimals(0)),
            Err(DecimalError::TooLarge)
        );
        assert_eq!(
            parse_units("340282366920938463463374607431768211455", Decimals(1)),
            Err(DecimalError::TooLarge)
        );
    }

    proptest! {
        #[test]
        fn parsing_a_formatted_amount_gives_it_back(raw: u128, places in 0_u8..=38) {
            let text = format_units(RawTokenAmount(raw), Decimals(places));
            prop_assert!(is_canonical(&text), "not canonical: {}", text);
            prop_assert_eq!(parse_units(&text, Decimals(places)), Ok(RawTokenAmount(raw)));
        }

        #[test]
        fn round_trips_even_with_more_decimals_than_digits(raw: u128, places: u8) {
            let text = format_units(RawTokenAmount(raw), Decimals(places));
            prop_assert!(is_canonical(&text), "not canonical: {}", text);
            prop_assert_eq!(parse_units(&text, Decimals(places)), Ok(RawTokenAmount(raw)));
        }

        #[test]
        fn signed_formatting_is_canonical_and_mirrors_unsigned(raw: i128, places in 0_u8..=38) {
            let text = format_signed_units(raw, Decimals(places));
            prop_assert!(is_canonical(&text), "not canonical: {}", text);
            let magnitude = format_units(RawTokenAmount(raw.unsigned_abs()), Decimals(places));
            if raw < 0 {
                prop_assert_eq!(text, format!("-{magnitude}"));
            } else {
                prop_assert_eq!(text, magnitude);
            }
        }
    }
}
