//! Synthetic account bytes exercise pinned IDL layouts; these are not mainnet captures.

use binsight_core::units::RawTokenAmount;
use binsight_dlmm::accounts::{
    AccountError, BinArray, BinLookup, LbPair, PositionV2, bin_array_index,
};
use binsight_solana::{Address, well_known};
use sha2::{Digest, Sha256};

const POOL: Address = Address::from_bytes([7; 32]);
const OWNER: Address = Address::from_bytes([8; 32]);

#[expect(
    clippy::unwrap_used,
    reason = "a SHA-256 digest always contains eight bytes"
)]
fn discriminator(name: &str) -> [u8; 8] {
    Sha256::digest(format!("account:{name}").as_bytes())
        .get(..8)
        .unwrap()
        .try_into()
        .unwrap()
}

#[expect(
    clippy::indexing_slicing,
    reason = "synthetic fixture buffers have fixed known sizes"
)]
fn synthetic_position(lower: i32, upper: i32, extra_bins: usize) -> Vec<u8> {
    let mut bytes = vec![0; 8_120 + 112 * extra_bins];
    bytes[..8].copy_from_slice(&discriminator("PositionV2"));
    bytes[8..40].copy_from_slice(POOL.as_bytes());
    bytes[40..72].copy_from_slice(OWNER.as_bytes());
    bytes[7_912..7_916].copy_from_slice(&lower.to_le_bytes());
    bytes[7_916..7_920].copy_from_slice(&upper.to_le_bytes());
    bytes
}

#[expect(
    clippy::indexing_slicing,
    reason = "synthetic fixture buffers have fixed known sizes"
)]
fn synthetic_array(index: i64) -> Vec<u8> {
    let mut bytes = vec![0; 10_136];
    bytes[..8].copy_from_slice(&discriminator("BinArray"));
    bytes[8..16].copy_from_slice(&index.to_le_bytes());
    bytes[24..56].copy_from_slice(POOL.as_bytes());
    bytes
}

#[test]
fn reads_inline_liquidity_and_fee_checkpoints_without_confusing_reward_fields() {
    let mut bytes = synthetic_position(-2, -1, 0);
    bytes[72..88].copy_from_slice(&u128::MAX.to_le_bytes());
    bytes[4_552..4_568].copy_from_slice(&123_u128.to_le_bytes());
    bytes[4_568..4_584].copy_from_slice(&456_u128.to_le_bytes());
    bytes[4_584..4_592].copy_from_slice(&789_u64.to_le_bytes());
    bytes[4_592..4_600].copy_from_slice(&u64::MAX.to_le_bytes());
    let position = PositionV2::decode(&bytes).unwrap();
    assert_eq!((position.lb_pair, position.owner), (POOL, OWNER));
    assert_eq!((position.lower_bin_id(), position.upper_bin_id()), (-2, -1));
    assert_eq!(position.bins().len(), 2);
    let bin = position.bins()[0];
    assert_eq!(bin.liquidity_share, u128::MAX);
    assert_eq!((bin.fees.complete_x, bin.fees.complete_y), (123, 456));
    assert_eq!(
        (bin.fees.pending_x, bin.fees.pending_y),
        (RawTokenAmount(789), RawTokenAmount(u128::from(u64::MAX)))
    );
    assert_eq!(position.bins()[1].liquidity_share, 0);
}

#[test]
fn reads_extended_bins_with_their_own_share_reward_and_fee_record() {
    let mut bytes = synthetic_position(-70, 0, 1);
    bytes[8_120..8_136].copy_from_slice(&999_u128.to_le_bytes());
    bytes[8_184..8_200].copy_from_slice(&321_u128.to_le_bytes());
    bytes[8_216..8_224].copy_from_slice(&654_u64.to_le_bytes());
    let position = PositionV2::decode(&bytes).unwrap();
    assert_eq!(position.bins().len(), 71);
    assert_eq!(position.bins()[70].liquidity_share, 999);
    assert_eq!(position.bins()[70].fees.complete_x, 321);
    assert_eq!(position.bins()[70].fees.pending_x, RawTokenAmount(654));
    assert_eq!(position.bins()[69].liquidity_share, 0);
}

#[test]
fn refuses_missing_extended_records_instead_of_inventing_zero_shares() {
    let bytes = synthetic_position(0, 70, 0);
    assert!(matches!(
        PositionV2::decode(&bytes),
        Err(AccountError::Malformed(_))
    ));
    let mut partial = synthetic_position(0, 70, 1);
    partial.pop();
    assert!(matches!(
        PositionV2::decode(&partial),
        Err(AccountError::Malformed(_))
    ));
}

#[test]
fn names_legacy_positions_and_rejects_unknown_discriminators() {
    let mut bytes = synthetic_position(0, 0, 0);
    bytes[..8].copy_from_slice(&discriminator("Position"));
    assert_eq!(
        PositionV2::decode(&bytes),
        Err(AccountError::LegacyPosition)
    );
    bytes[..8].fill(0);
    assert!(matches!(
        PositionV2::decode(&bytes),
        Err(AccountError::UnknownDiscriminator { .. })
    ));
    assert!(PositionV2::decode(&bytes[..7]).is_err());
}

#[test]
fn refuses_inverted_oversized_and_extreme_bin_ranges_before_allocating() {
    for (lower, upper) in [(1, 0), (0, 1_400), (i32::MIN, i32::MAX)] {
        assert_eq!(
            PositionV2::decode(&synthetic_position(lower, upper, 0)),
            Err(AccountError::InvalidRange { lower, upper })
        );
    }
    assert_eq!(
        PositionV2::decode(&synthetic_position(-700, 699, 1_330))
            .unwrap()
            .bins()
            .len(),
        1_400
    );
}

#[test]
fn reads_both_token_programs_and_refuses_an_unknown_program_flag() {
    let mut bytes = vec![0; 904];
    bytes[..8].copy_from_slice(&discriminator("LbPair"));
    bytes[76..80].copy_from_slice(&(-443_636_i32).to_le_bytes());
    bytes[80..82].copy_from_slice(&25_u16.to_le_bytes());
    bytes[88..120].copy_from_slice(POOL.as_bytes());
    bytes[120..152].copy_from_slice(OWNER.as_bytes());
    bytes[881] = 1;
    let pair = LbPair::decode(&bytes).unwrap();
    assert_eq!((pair.active_id, pair.bin_step), (-443_636, 25));
    assert_eq!((pair.mint_x, pair.mint_y), (POOL, OWNER));
    assert_eq!(
        (pair.x_program, pair.y_program),
        (well_known::TOKEN_PROGRAM, well_known::TOKEN_2022_PROGRAM)
    );
    bytes[880] = 2;
    assert_eq!(
        LbPair::decode(&bytes),
        Err(AccountError::UnsupportedTokenProgram(2))
    );
    assert!(LbPair::decode(&bytes[..903]).is_err());
}

#[test]
fn reads_the_last_negative_bin_and_excludes_limit_order_fields_from_its_balances() {
    let mut bytes = synthetic_array(-1);
    let start = 56 + 69 * 144;
    bytes[start..start + 8].copy_from_slice(&u64::MAX.to_le_bytes());
    bytes[start + 8..start + 16].copy_from_slice(&123_u64.to_le_bytes());
    bytes[start + 32..start + 48].copy_from_slice(&u128::MAX.to_le_bytes());
    bytes[start + 48..start + 80].fill(0xff);
    bytes[start + 80..start + 96].copy_from_slice(&456_u128.to_le_bytes());
    bytes[start + 96..start + 112].copy_from_slice(&789_u128.to_le_bytes());
    let array = BinArray::decode(&bytes).unwrap();
    assert_eq!(array.index(), -1);
    let bin = array.bin(-1).unwrap();
    assert_eq!(
        (bin.amount_x, bin.amount_y),
        (RawTokenAmount(u128::from(u64::MAX)), RawTokenAmount(123))
    );
    assert_eq!(bin.liquidity_supply, u128::MAX);
    assert_eq!((bin.fee_x_per_token, bin.fee_y_per_token), (456, 789));
    assert!(array.bin(0).is_none());
    assert!(array.bin(-71).is_none());
    assert!(BinArray::decode(&bytes[..10_135]).is_err());
}

#[test]
fn floor_divides_array_indices_across_zero_and_negative_boundaries() {
    for (bin, index) in [
        (-71, -2),
        (-70, -1),
        (-1, -1),
        (0, 0),
        (69, 0),
        (70, 1),
        (i32::MIN, -30_678_338),
        (i32::MAX, 30_678_337),
    ] {
        assert_eq!(bin_array_index(bin), index);
    }
}

#[test]
fn keeps_missing_arrays_absent_and_refuses_cross_pool_or_duplicate_snapshots() {
    let array = BinArray::decode(&synthetic_array(0)).unwrap();
    let lookup = BinLookup::new(POOL, vec![array.clone()]).unwrap();
    assert!(lookup.bin(0).is_some());
    assert!(lookup.bin(-1).is_none());
    assert!(matches!(
        BinLookup::new(OWNER, vec![array.clone()]),
        Err(AccountError::WrongPool { .. })
    ));
    assert!(matches!(
        BinLookup::new(POOL, vec![array.clone(), array]),
        Err(AccountError::DuplicateBinArray(0))
    ));
}
