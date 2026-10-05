//! PDA vectors from Solana SDK revision 6c76e236, independent of binsight's implementation.

use binsight_solana::{
    Address,
    program_address::{ProgramAddressError, create_program_address, find_program_address},
};

#[test]
fn matches_pinned_sdk_addresses_for_empty_unicode_and_multiple_seeds() {
    let program: Address = "BPFLoaderUpgradeab1e11111111111111111111111"
        .parse()
        .unwrap();
    for (seeds, expected) in [
        (
            vec![b"".as_slice(), &[1]],
            "BwqrghZA2htAcqq8dzP1WDAhTXYTYWj7CHxF5j7TDBAe",
        ),
        (
            vec!["☉".as_bytes(), &[0]],
            "13yWmRpaTR4r5nAktwLqMpRNr28tnVUZw26rTvPSSB19",
        ),
        (
            vec![b"Talking".as_slice(), b"Squirrels"],
            "2fnQrngrQT4SeLcdToJAD96phoEjNL2man2kfRLCASVk",
        ),
    ] {
        assert_eq!(
            create_program_address(program, &seeds),
            Ok(expected.parse().unwrap())
        );
    }
}

#[test]
fn accepts_the_runtime_seed_limits_and_reserves_one_slot_for_the_bump() {
    let program: Address = "BPFLoaderUpgradeab1e11111111111111111111111"
        .parse()
        .unwrap();
    assert!(create_program_address(program, &[&[0; 32]]).is_ok());
    assert_eq!(
        create_program_address(program, &[&[0; 33]]),
        Err(ProgramAddressError::SeedTooLong)
    );
    assert_eq!(
        find_program_address(program, &[&[0; 33]]),
        Err(ProgramAddressError::SeedTooLong)
    );
    assert_eq!(
        create_program_address(program, &[b"".as_slice(); 17]),
        Err(ProgramAddressError::TooManySeeds)
    );
    assert_eq!(
        find_program_address(program, &[b"".as_slice(); 16]),
        Err(ProgramAddressError::TooManySeeds)
    );
    let derived = find_program_address(program, &[b"".as_slice(); 15]).unwrap();
    let mut with_bump = vec![b"".as_slice(); 15];
    let bump = [derived.bump];
    with_bump.push(&bump);
    assert_eq!(
        create_program_address(program, &with_bump),
        Ok(derived.address)
    );
}
