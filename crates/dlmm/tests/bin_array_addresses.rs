//! Offline vectors produced by @solana/web3.js 1.98.4 using the pinned DLMM program ID.

use binsight_dlmm::{
    accounts::bin_array_address,
    program::{EVENT_AUTHORITY, PROGRAM_ID},
};
use binsight_solana::{
    Address,
    program_address::{ProgramAddressError, create_program_address, find_program_address},
};

#[test]
fn matches_sdk_bin_array_addresses_and_the_largest_off_curve_bump() {
    let pool: Address = "DR26Cff6PrjzhyoHzV59Wjgxg7NuW4JSnHbdz6RE8Bho"
        .parse()
        .unwrap();
    for (index, expected, bump) in [
        (-2_i64, "HCUkwKh57vfbevicmDTwxPFUjo9miZh9V9hQQSFhUUqW", 255),
        (-1, "4AvymugneXQDSxK77ukghsbjQ1pAE9nc6zn6dv7LqqnP", 248),
        (0, "ojwnNC55kk87WeZGhMPsVCmZkqLtLvk5ctSoeiJBUqG", 254),
        (1, "8jC9Gyd5sFqar6EuuYXzSVR5vLVsZWmd4ZRW8hxr8VH9", 255),
        (
            30_678_337,
            "5yYHFaoon2UCiNomXbY3UobbzC8pR1b3oEjVGKh5g8DR",
            255,
        ),
    ] {
        let derived = bin_array_address(pool, index).unwrap();
        assert_eq!(derived.address, expected.parse().unwrap());
        assert_eq!(derived.bump, bump);
        let index_bytes = index.to_le_bytes();
        assert_eq!(
            create_program_address(
                PROGRAM_ID,
                &[b"bin_array", pool.as_bytes(), &index_bytes, &[bump]]
            ),
            Ok(derived.address)
        );
        for higher_bump in bump.saturating_add(1)..=u8::MAX {
            if higher_bump == bump {
                continue;
            }
            assert_eq!(
                create_program_address(
                    PROGRAM_ID,
                    &[b"bin_array", pool.as_bytes(), &index_bytes, &[higher_bump]]
                ),
                Err(ProgramAddressError::OnCurve)
            );
        }
    }
}

#[test]
fn derives_the_existing_event_authority_from_its_anchor_seed() {
    assert_eq!(
        find_program_address(PROGRAM_ID, &[b"__event_authority"])
            .unwrap()
            .address,
        EVENT_AUTHORITY
    );
}
