//! Wide Q64 division checked against independent integer oracles and bounded exhaustive cases.

use binsight_core::units::RawTokenAmount;
use binsight_dlmm::math::{Q64DivisionError, Q64x64, div_q64, div_raw_q64, mul_shr_64};
use proptest::prelude::*;
use serde::Deserialize;

#[derive(Deserialize)]
struct DivisionCase {
    value: String,
    price: String,
    expected: Option<String>,
}

#[test]
fn matches_python_unbounded_integer_division_at_wide_boundaries() {
    let cases: Vec<DivisionCase> =
        serde_json::from_str(include_str!("fixtures/math/q64-division.json")).unwrap();
    for case in cases {
        let value = RawTokenAmount(case.value.parse().unwrap());
        let price = Q64x64(case.price.parse().unwrap());
        let expected = match case.expected {
            Some(amount) => Ok(RawTokenAmount(amount.parse().unwrap())),
            None if price.0 == 0 => Err(Q64DivisionError::ZeroPrice),
            None => Err(Q64DivisionError::Overflow),
        };
        assert_eq!(
            div_raw_q64(value, price),
            expected,
            "{case_value} / {case_price}",
            case_value = case.value,
            case_price = case.price
        );
    }
}

#[test]
fn divides_every_small_amount_and_price_without_rounding_a_reciprocal() {
    for value in 0_u64..=255 {
        for price in 0_u128..=255 {
            let expected = (u128::from(value) << 64)
                .checked_div(price)
                .map(RawTokenAmount)
                .ok_or(Q64DivisionError::ZeroPrice);
            assert_eq!(
                div_raw_q64(RawTokenAmount(u128::from(value)), Q64x64(price)),
                expected
            );
            assert_eq!(
                div_q64(value, Q64x64(price)),
                expected.ok().map(|amount| amount.0)
            );
        }
    }
}

#[test]
fn preserves_the_last_raw_unit_that_a_rounded_reciprocal_loses() {
    let price = Q64x64(Q64x64::ONE.0.checked_mul(3).unwrap());
    assert_eq!(div_raw_q64(RawTokenAmount(3), price), Ok(RawTokenAmount(1)));
    let rounded_reciprocal = Q64x64(Q64x64::ONE.0 / 3);
    assert_eq!(mul_shr_64(3, rounded_reciprocal), Some(0));
}

#[test]
fn distinguishes_a_zero_price_from_an_amount_overflow() {
    assert_eq!(
        div_raw_q64(RawTokenAmount(0), Q64x64(0)),
        Err(Q64DivisionError::ZeroPrice)
    );
    assert_eq!(
        div_raw_q64(RawTokenAmount(u128::MAX), Q64x64(1)),
        Err(Q64DivisionError::Overflow)
    );
    assert_eq!(
        div_raw_q64(RawTokenAmount(u128::MAX), Q64x64::ONE),
        Ok(RawTokenAmount(u128::MAX))
    );
}

#[test]
fn accepts_the_last_fitting_amount_before_a_fractional_price_overflows() {
    let price = Q64x64(Q64x64::ONE.0.checked_sub(1).unwrap());
    let last_fitting = u128::MAX.checked_sub(Q64x64::ONE.0).unwrap();
    assert_eq!(
        div_raw_q64(RawTokenAmount(last_fitting), price),
        Ok(RawTokenAmount(u128::MAX.checked_sub(1).unwrap()))
    );
    assert_eq!(
        div_raw_q64(RawTokenAmount(last_fitting.checked_add(1).unwrap()), price),
        Err(Q64DivisionError::Overflow)
    );
}

proptest! {
    #[test]
    fn matches_the_direct_u64_numerator_and_preserves_the_existing_interface(value: u64, price: u128) {
        let expected = (u128::from(value) << 64).checked_div(price);
        prop_assert_eq!(div_raw_q64(RawTokenAmount(u128::from(value)), Q64x64(price)).ok().map(|amount| amount.0), expected);
        prop_assert_eq!(div_q64(value, Q64x64(price)), expected);
    }

    #[test]
    fn divides_full_width_amounts_at_integer_prices(value: u128, integer_price in 1_u64..=u64::MAX) {
        let price = Q64x64(u128::from(integer_price) << 64);
        let expected = value.checked_div(u128::from(integer_price)).unwrap();
        prop_assert_eq!(div_raw_q64(RawTokenAmount(value), price), Ok(RawTokenAmount(expected)));
    }
}
