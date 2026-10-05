//! Derivation of DLMM bin array addresses from the pool and signed little-endian array index.

use binsight_solana::{
    Address,
    program_address::{ProgramAddress, ProgramAddressError, find_program_address},
};

use crate::program::PROGRAM_ID;

const BIN_ARRAY_SEED: &[u8] = b"bin_array";

/// Derives a bin array's canonical address, including negative array indices.
///
/// # Errors
/// Returns an error when no off-curve bump exists.
pub fn bin_array_address(pool: Address, index: i64) -> Result<ProgramAddress, ProgramAddressError> {
    find_program_address(
        PROGRAM_ID,
        &[BIN_ARRAY_SEED, pool.as_bytes(), &index.to_le_bytes()],
    )
}
