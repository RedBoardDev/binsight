//! Pure Solana PDA derivation: SHA-256 seeds and rejection of every ed25519 curve point.
//!
//! The canonical bump search follows Solana SDK revision
//! `6c76e2368e60b89da70fa6b5ce0e4433de972ede`: bumps 255 down to 1.

use curve25519_dalek::edwards::CompressedEdwardsY;
use sha2::{Digest, Sha256};
use thiserror::Error;

use crate::Address;

const MAX_SEEDS: usize = 16;
const MAX_SEED_BYTES: usize = 32;
const PDA_MARKER: &[u8] = b"ProgramDerivedAddress";

/// An off-curve program-derived address and its canonical bump.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ProgramAddress {
    /// The address controlled by the program.
    pub address: Address,
    /// Highest accepted bump, appended after the supplied seeds.
    pub bump: u8,
}

/// A seed set cannot produce an accepted program-derived address.
#[derive(Debug, Clone, Copy, Error, PartialEq, Eq)]
pub enum ProgramAddressError {
    /// The supplied seed list exceeds the runtime limit.
    #[error("too many program address seeds")]
    TooManySeeds,
    /// A seed is longer than the runtime allows.
    #[error("program address seed exceeds 32 bytes")]
    SeedTooLong,
    /// The hash can be represented by an ed25519 public key.
    #[error("program address lies on the ed25519 curve")]
    OnCurve,
    /// Every canonical bump candidate lies on the curve.
    #[error("no off-curve program address bump exists")]
    NoBump,
}

/// Derives a PDA from exact seeds, including a previously stored bump when needed.
///
/// # Errors
/// Refuses oversized seed sets and hashes that lie on the ed25519 curve.
pub fn create_program_address(
    program: Address,
    seeds: &[&[u8]],
) -> Result<Address, ProgramAddressError> {
    let hash = hash_seeds(seeds)?;
    finish_address(hash, program)
}

/// Finds the largest accepted runtime bump without allocating a seed list per attempt.
///
/// # Errors
/// Refuses oversized seeds, a list leaving no room for a bump, or no accepted bump.
pub fn find_program_address(
    program: Address,
    seeds: &[&[u8]],
) -> Result<ProgramAddress, ProgramAddressError> {
    if seeds.len() >= MAX_SEEDS {
        return Err(ProgramAddressError::TooManySeeds);
    }
    let hash = hash_seeds(seeds)?;
    for bump in (1..=u8::MAX).rev() {
        let mut candidate = hash.clone();
        candidate.update([bump]);
        match finish_address(candidate, program) {
            Ok(address) => return Ok(ProgramAddress { address, bump }),
            Err(ProgramAddressError::OnCurve) => {}
            Err(error) => return Err(error),
        }
    }
    Err(ProgramAddressError::NoBump)
}

fn hash_seeds(seeds: &[&[u8]]) -> Result<Sha256, ProgramAddressError> {
    if seeds.len() > MAX_SEEDS {
        return Err(ProgramAddressError::TooManySeeds);
    }
    let mut hash = Sha256::new();
    for seed in seeds {
        if seed.len() > MAX_SEED_BYTES {
            return Err(ProgramAddressError::SeedTooLong);
        }
        hash.update(seed);
    }
    Ok(hash)
}

fn finish_address(mut hash: Sha256, program: Address) -> Result<Address, ProgramAddressError> {
    hash.update(program.as_bytes());
    hash.update(PDA_MARKER);
    let bytes: [u8; 32] = hash.finalize().into();
    if CompressedEdwardsY(bytes).decompress().is_some() {
        return Err(ProgramAddressError::OnCurve);
    }
    Ok(Address::from_bytes(bytes))
}
