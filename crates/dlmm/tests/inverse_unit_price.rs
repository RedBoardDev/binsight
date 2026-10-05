//! Reciprocal display prices agree with unbounded integer division, without rounded reciprocals.
use binsight_core::price::Price;
use binsight_core::units::Decimals;
use binsight_dlmm::math::{BinMathError, Q64x64, inverse_unit_price, unit_price};
use proptest::prelude::*;
use serde::Deserialize;

#[derive(Deserialize)]
struct InversePriceCase {
    raw: String,
    x_decimals: u8,
    y_decimals: u8,
    expected: Option<String>,
}

#[test]
fn matches_python_bigint_across_full_width_prices_and_all_token_decimals() {
    let cases: Vec<InversePriceCase> =
        serde_json::from_str(include_str!("fixtures/math/inverse-unit-price.json")).unwrap();
    for case in cases {
        let raw = Q64x64(case.raw.parse().unwrap());
        let expected = match case.expected {
            Some(value) => Ok(Price(value.parse().unwrap())),
            None if raw.0 == 0 => Err(BinMathError::ZeroPrice),
            None => Err(BinMathError::Overflow),
        };
        assert_eq!(
            inverse_unit_price(raw, Decimals(case.x_decimals), Decimals(case.y_decimals)),
            expected,
            "raw {}, X decimals {}, Y decimals {}",
            case.raw,
            case.x_decimals,
            case.y_decimals
        );
    }
}

#[test]
fn retains_the_remainder_that_inverting_a_rounded_display_price_loses() {
    let raw = Q64x64(Q64x64::ONE.0.checked_add(1).unwrap());
    let forward = unit_price(raw, Decimals(9), Decimals(9)).unwrap();
    let reciprocal_of_rounded = Price(10_u128.pow(36) / forward.0);
    assert_eq!(reciprocal_of_rounded, Price(10_u128.pow(18)));
    assert_eq!(
        inverse_unit_price(raw, Decimals(9), Decimals(9)),
        Ok(Price(999_999_999_999_999_999))
    );
}

#[test]
fn avoids_a_power_of_ten_overflow_when_the_final_price_still_fits() {
    // The conceptual numerator is 2^64 * 10^56, beyond u128; its quotient fits.
    assert_eq!(
        inverse_unit_price(Q64x64(u128::MAX), Decimals(0), Decimals(38)),
        Ok(Price(5_421_010_862_427_522_170_037_264_004_349_708_557))
    );
}

#[test]
fn distinguishes_a_zero_raw_price_from_a_positive_price_below_display_resolution() {
    assert_eq!(
        inverse_unit_price(Q64x64(0), Decimals(255), Decimals(0)),
        Err(BinMathError::ZeroPrice)
    );
    assert_eq!(
        inverse_unit_price(Q64x64(u128::MAX), Decimals(255), Decimals(0)),
        Ok(Price(0))
    );
}

#[test]
fn rejects_only_a_result_that_exceeds_the_price_integer_range() {
    assert_eq!(
        inverse_unit_price(Q64x64(1), Decimals(0), Decimals(0)),
        Ok(Price(Q64x64::ONE.0 * 10_u128.pow(18)))
    );
    assert_eq!(
        inverse_unit_price(Q64x64(1), Decimals(0), Decimals(1)),
        Ok(Price(Q64x64::ONE.0 * 10_u128.pow(19)))
    );
    assert_eq!(
        inverse_unit_price(Q64x64(1), Decimals(0), Decimals(2)),
        Err(BinMathError::Overflow)
    );
}

proptest! {
    #[test]
    fn agrees_with_direct_division_when_the_scaled_numerator_fits(raw in 1_u128..=u128::MAX, shift in 0_u8..=19) {
        let numerator = Q64x64::ONE.0.checked_mul(10_u128.pow(u32::from(shift))).unwrap();
        let expected = Price(numerator / raw);
        prop_assert_eq!(inverse_unit_price(Q64x64(raw), Decimals(18), Decimals(shift)), Ok(expected));
    }

    #[test]
    fn decreases_as_the_original_raw_price_increases(raw in 1_u128..u128::MAX, x: u8, y: u8) {
        let lower = inverse_unit_price(Q64x64(raw), Decimals(x), Decimals(y));
        let higher = inverse_unit_price(Q64x64(raw + 1), Decimals(x), Decimals(y));
        if let (Ok(lower), Ok(higher)) = (lower, higher) {
            prop_assert!(lower >= higher);
        }
    }
}
