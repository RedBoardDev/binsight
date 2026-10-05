//! Fully synthetic snapshots compared against the SDK, plus incomplete and inconsistent cases.

use binsight_core::{error::AmountError, units::RawTokenAmount};
use binsight_dlmm::{
    accounts::{BinArray, BinLookup, PositionV2},
    math::{PositionAmounts, PositionValueError, position_amounts},
};
use binsight_solana::Address;

const POOL: Address = Address::from_bytes([7; 32]);
const FIRST_NEGATIVE_BIN: usize = 56 + 53 * 144;

#[expect(
    clippy::indexing_slicing,
    reason = "fixed-sized synthetic account bytes"
)]
#[expect(
    clippy::unwrap_used,
    reason = "known synthetic ranges and valid fixture layouts"
)]
fn synthetic_array(index: i64) -> Vec<u8> {
    let mut bytes = vec![0; 10_136];
    bytes[..8].copy_from_slice(&[92, 142, 92, 220, 5, 148, 70, 181]);
    bytes[8..16].copy_from_slice(&index.to_le_bytes());
    bytes[24..56].copy_from_slice(POOL.as_bytes());
    for offset in 0..70 {
        let bin_id = index * 70 + i64::try_from(offset).unwrap();
        let start = 56 + offset * 144;
        let x = u64::try_from(bin_id + 71).unwrap() * 12_345;
        let y = u64::try_from(70 - bin_id).unwrap() * 3_219;
        bytes[start..start + 8].copy_from_slice(&x.to_le_bytes());
        bytes[start + 8..start + 16].copy_from_slice(&y.to_le_bytes());
        set_u128(&mut bytes, start + 16, 1 << 64);
        set_u128(
            &mut bytes,
            start + 32,
            u128::try_from(bin_id + 1070).unwrap() << 64,
        );
        set_u128(
            &mut bytes,
            start + 80,
            u128::try_from(bin_id + 71).unwrap() << 63,
        );
        set_u128(
            &mut bytes,
            start + 96,
            u128::try_from(bin_id + 72).unwrap() << 62,
        );
    }
    bytes
}

#[expect(
    clippy::indexing_slicing,
    reason = "fixed-sized synthetic account bytes"
)]
#[expect(
    clippy::unwrap_used,
    reason = "known synthetic ranges and valid fixture layouts"
)]
fn synthetic_position() -> Vec<u8> {
    let mut bytes = vec![0; 8_120 + 17 * 112];
    bytes[..8].copy_from_slice(&[117, 176, 212, 199, 245, 180, 133, 182]);
    bytes[8..40].copy_from_slice(POOL.as_bytes());
    bytes[40..72].copy_from_slice(&[8; 32]);
    bytes[7_912..7_916].copy_from_slice(&(-17_i32).to_le_bytes());
    bytes[7_916..7_920].copy_from_slice(&69_i32.to_le_bytes());
    for offset in 0..87 {
        let bin_id = i128::try_from(offset).unwrap() - 17;
        let supply = u128::try_from(bin_id + 1070).unwrap() << 64;
        let (share_at, fee_at) = if offset < 70 {
            (72 + offset * 16, 4_552 + offset * 48)
        } else {
            let start = 8_120 + (offset - 70) * 112;
            (start, start + 64)
        };
        set_u128(&mut bytes, share_at, supply / 3);
        set_u128(
            &mut bytes,
            fee_at,
            u128::try_from(bin_id + 71).unwrap() << 62,
        );
        set_u128(
            &mut bytes,
            fee_at + 16,
            u128::try_from(bin_id + 72).unwrap() << 61,
        );
        bytes[fee_at + 32..fee_at + 40]
            .copy_from_slice(&u64::try_from(offset + 1).unwrap().to_le_bytes());
        bytes[fee_at + 40..fee_at + 48]
            .copy_from_slice(&u64::try_from(offset + 2).unwrap().to_le_bytes());
    }
    bytes
}

#[expect(
    clippy::unwrap_used,
    reason = "known synthetic ranges and valid fixture layouts"
)]
fn lookup(arrays: Vec<BinArray>) -> BinLookup {
    BinLookup::new(POOL, arrays).unwrap()
}

#[expect(
    clippy::unwrap_used,
    reason = "known synthetic ranges and valid fixture layouts"
)]
fn full_lookup() -> BinLookup {
    lookup(vec![
        BinArray::decode(&synthetic_array(0)).unwrap(),
        BinArray::decode(&synthetic_array(-1)).unwrap(),
    ])
}

#[expect(
    clippy::indexing_slicing,
    reason = "fixed-sized synthetic account bytes"
)]
fn set_u128(bytes: &mut [u8], offset: usize, value: u128) {
    bytes[offset..offset + 16].copy_from_slice(&value.to_le_bytes());
}

#[test]
fn matches_sdk_raw_amounts_and_fees_across_inline_and_extended_bins() {
    let position = PositionV2::decode(&synthetic_position()).unwrap();
    assert_eq!(position.bins().len(), 87);
    let expected: serde_json::Value = serde_json::from_str(include_str!(
        "fixtures/math/synthetic-position-sdk-expected.json"
    ))
    .unwrap();
    let totals = position_amounts(&position, &full_lookup()).unwrap();
    for (name, amount) in [
        ("amount_x", totals.amount_x),
        ("amount_y", totals.amount_y),
        ("fee_x", totals.fee_x),
        ("fee_y", totals.fee_y),
    ] {
        assert_eq!(amount.0.to_string(), expected[name].as_str().unwrap());
    }
    assert!(totals.is_complete);
}

#[test]
fn preserves_pending_fees_and_marks_missing_liquidity_as_incomplete() {
    let totals = position_amounts(
        &PositionV2::decode(&synthetic_position()).unwrap(),
        &lookup(vec![]),
    )
    .unwrap();
    assert_eq!(
        totals,
        PositionAmounts {
            amount_x: RawTokenAmount::ZERO,
            amount_y: RawTokenAmount::ZERO,
            fee_x: RawTokenAmount(3_828),
            fee_y: RawTokenAmount(3_915),
            is_complete: false,
        }
    );
    let partial = position_amounts(
        &PositionV2::decode(&synthetic_position()).unwrap(),
        &lookup(vec![BinArray::decode(&synthetic_array(-1)).unwrap()]),
    )
    .unwrap();
    let full = position_amounts(
        &PositionV2::decode(&synthetic_position()).unwrap(),
        &full_lookup(),
    )
    .unwrap();
    assert!(!partial.is_complete);
    assert!(partial.amount_y > RawTokenAmount::ZERO);
    assert!(partial.amount_x <= full.amount_x);
    assert!(partial.fee_x <= full.fee_x);
}

#[test]
fn needs_no_arrays_for_zero_shares_and_keeps_the_pending_fees() {
    let mut bytes = synthetic_position();
    for index in 0..87 {
        let offset = if index < 70 {
            72 + index * 16
        } else {
            8120 + (index - 70) * 112
        };
        set_u128(&mut bytes, offset, 0);
    }
    let totals = position_amounts(&PositionV2::decode(&bytes).unwrap(), &lookup(vec![])).unwrap();
    assert!(totals.is_complete);
    assert_eq!(totals.amount_x, RawTokenAmount::ZERO);
    assert_eq!(totals.fee_x, RawTokenAmount(3_828));
}

#[test]
fn refuses_a_lookup_from_another_pool() {
    let wrong = BinLookup::new(Address::from_bytes([6; 32]), vec![]).unwrap();
    assert!(matches!(
        position_amounts(&PositionV2::decode(&synthetic_position()).unwrap(), &wrong),
        Err(PositionValueError::WrongPool { .. })
    ));
}

#[test]
fn refuses_zero_supply_and_a_share_exceeding_supply() {
    for supply in [0, 1] {
        let mut bytes = synthetic_array(-1);
        set_u128(&mut bytes, FIRST_NEGATIVE_BIN + 32, supply);
        let bins = lookup(vec![BinArray::decode(&bytes).unwrap()]);
        assert_eq!(
            position_amounts(&PositionV2::decode(&synthetic_position()).unwrap(), &bins),
            Err(PositionValueError::InvalidLiquidity { bin_id: -17 })
        );
    }
}

#[test]
fn refuses_accumulator_rewinds_instead_of_guessing_a_wrap() {
    for checkpoint_offset in [4_552, 4_568] {
        let mut bytes = synthetic_position();
        set_u128(&mut bytes, checkpoint_offset, u128::MAX);
        assert_eq!(
            position_amounts(&PositionV2::decode(&bytes).unwrap(), &full_lookup()),
            Err(PositionValueError::AccumulatorRewind { bin_id: -17 })
        );
    }
}

#[test]
fn reports_overflow_when_unsettled_fees_cannot_be_summed() {
    let mut position = synthetic_position();
    let mut array = synthetic_array(-1);
    for index in 0..2 {
        set_u128(&mut position, 72 + 16 * index, u128::MAX);
        set_u128(&mut position, 4_552 + 48 * index, 0);
        set_u128(&mut array, FIRST_NEGATIVE_BIN + 144 * index + 32, u128::MAX);
        set_u128(&mut array, FIRST_NEGATIVE_BIN + 144 * index + 80, u128::MAX);
    }
    let bins = lookup(vec![BinArray::decode(&array).unwrap()]);
    assert_eq!(
        position_amounts(&PositionV2::decode(&position).unwrap(), &bins),
        Err(PositionValueError::Amount(AmountError::Overflow))
    );
}

#[test]
fn floors_liquidity_and_truncates_shares_before_unsettled_fees() {
    let mut position = synthetic_position()[..8_120].to_vec();
    position[7_912..7_916].copy_from_slice(&0_i32.to_le_bytes());
    position[7_916..7_920].copy_from_slice(&0_i32.to_le_bytes());
    set_u128(&mut position, 72, 3 << 63);
    set_u128(&mut position, 4_552, 0);
    set_u128(&mut position, 4_568, 0);
    position[4_584..4_592].copy_from_slice(&7_u64.to_le_bytes());
    position[4_592..4_600].copy_from_slice(&8_u64.to_le_bytes());
    let mut array = synthetic_array(0);
    array[56..64].copy_from_slice(&11_u64.to_le_bytes());
    array[64..72].copy_from_slice(&13_u64.to_le_bytes());
    set_u128(&mut array, 56 + 32, 3 << 64);
    set_u128(&mut array, 56 + 80, 3 << 63);
    set_u128(&mut array, 56 + 96, 3 << 63);
    let bins = lookup(vec![BinArray::decode(&array).unwrap()]);
    assert_eq!(
        position_amounts(&PositionV2::decode(&position).unwrap(), &bins).unwrap(),
        PositionAmounts {
            amount_x: RawTokenAmount(5),
            amount_y: RawTokenAmount(6),
            fee_x: RawTokenAmount(8),
            fee_y: RawTokenAmount(9),
            is_complete: true
        }
    );
}
