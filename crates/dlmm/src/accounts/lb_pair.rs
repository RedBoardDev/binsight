//! The pool fields needed to identify tokens and the active price bin.

use binsight_solana::{Address, well_known};

use super::{
    AccountError,
    reading::{check_discriminator, reader_at, require_length},
};

const DISCRIMINATOR: [u8; 8] = [33, 11, 49, 98, 181, 101, 177, 13];
const PAIR_BYTES: usize = 904;
const ACTIVE_ID_OFFSET: usize = 76;
const MINTS_OFFSET: usize = 88;
const PROGRAM_FLAGS_OFFSET: usize = 880;

/// A pool's current bin and the exact token programs of its two mints.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LbPair {
    /// Current active bin.
    pub active_id: i32,
    /// Price increment in basis points.
    pub bin_step: u16,
    /// X mint.
    pub mint_x: Address,
    /// Y mint.
    pub mint_y: Address,
    /// Program owning mint X.
    pub x_program: Address,
    /// Program owning mint Y.
    pub y_program: Address,
}

impl LbPair {
    /// Decodes a pool snapshot, including Token-2022 program flags.
    ///
    /// # Errors
    /// Refuses an unknown layout, truncated bytes or unknown token program flag.
    pub fn decode(bytes: &[u8]) -> Result<Self, AccountError> {
        check_discriminator(bytes, DISCRIMINATOR, "lb pair")?;
        require_length(bytes, PAIR_BYTES)?;
        let mut active = reader_at(bytes, ACTIVE_ID_OFFSET)?;
        let active_id = active.read_i32("active bin id")?;
        let bin_step = active.read_u16("bin step")?;
        let mut mints = reader_at(bytes, MINTS_OFFSET)?;
        let mint_x = mints.read_address("mint X")?;
        let mint_y = mints.read_address("mint Y")?;
        let mut flags = reader_at(bytes, PROGRAM_FLAGS_OFFSET)?;
        Ok(Self {
            active_id,
            bin_step,
            mint_x,
            mint_y,
            x_program: token_program(flags.read_u8("mint X program flag")?)?,
            y_program: token_program(flags.read_u8("mint Y program flag")?)?,
        })
    }
}

fn token_program(flag: u8) -> Result<Address, AccountError> {
    match flag {
        0 => Ok(well_known::TOKEN_PROGRAM),
        1 => Ok(well_known::TOKEN_2022_PROGRAM),
        _ => Err(AccountError::UnsupportedTokenProgram(flag)),
    }
}
