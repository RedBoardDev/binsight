//! `PositionV2`'s inline liquidity and fee checkpoints, followed by extended bin records.

use binsight_core::units::RawTokenAmount;
use binsight_solana::{Address, ByteReader};

use super::{
    AccountError,
    reading::{check_discriminator, offset_of, reader_at, require_length},
};

const POSITION_DISCRIMINATOR: [u8; 8] = [117, 176, 212, 199, 245, 180, 133, 182];
const LEGACY_DISCRIMINATOR: [u8; 8] = [170, 188, 143, 228, 122, 64, 247, 208];
const INLINE_BINS: usize = 70;
const MAX_POSITION_BINS: usize = 1_400;
const POSITION_BYTES: usize = 8_120;
const RANGE_OFFSET: usize = 7_912;
const SHARES_OFFSET: usize = 72;
const SHARE_BYTES: usize = 16;
const FEES_OFFSET: usize = 4_552;
const FEE_BYTES: usize = 48;
const EXTENDED_BIN_BYTES: usize = 112;
const EXTENDED_FEES_OFFSET: usize = 64;

/// A bin's fee accumulator checkpoints and already accrued raw fees.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FeeCheckpoint {
    /// Last settled X accumulator, in Q64.64 units.
    pub complete_x: u128,
    /// Last settled Y accumulator, in Q64.64 units.
    pub complete_y: u128,
    /// X fees owed even when the liquidity share is zero.
    pub pending_x: RawTokenAmount,
    /// Y fees owed even when the liquidity share is zero.
    pub pending_y: RawTokenAmount,
}

/// A position's liquidity and fee entitlement in one bin.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PositionBin {
    /// Q64.64 liquidity shares.
    pub liquidity_share: u128,
    /// Settled and pending fees.
    pub fees: FeeCheckpoint,
}

/// A fully decoded supported position; its bin list exactly covers its range.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PositionV2 {
    /// Pool containing this position.
    pub lb_pair: Address,
    /// Position owner.
    pub owner: Address,
    lower_bin_id: i32,
    upper_bin_id: i32,
    bins: Vec<PositionBin>,
}

impl PositionV2 {
    /// Decodes the fixed layout and every extended bin required by the range.
    ///
    /// # Errors
    /// Refuses legacy or unknown layouts, invalid ranges and missing bin records.
    pub fn decode(bytes: &[u8]) -> Result<Self, AccountError> {
        let discriminator = ByteReader::new(bytes).read_array("position discriminator")?;
        if discriminator == LEGACY_DISCRIMINATOR {
            return Err(AccountError::LegacyPosition);
        }
        check_discriminator(bytes, POSITION_DISCRIMINATOR, "position")?;
        require_length(bytes, POSITION_BYTES)?;
        let mut header = reader_at(bytes, 8)?;
        let lb_pair = header.read_address("position pool")?;
        let owner = header.read_address("position owner")?;
        let mut range = reader_at(bytes, RANGE_OFFSET)?;
        let lower_bin_id = range.read_i32("lower bin id")?;
        let upper_bin_id = range.read_i32("upper bin id")?;
        let width = position_width(lower_bin_id, upper_bin_id)?;
        let mut bins = Vec::with_capacity(width);
        for index in 0..width {
            bins.push(read_bin(bytes, index)?);
        }
        Ok(Self {
            lb_pair,
            owner,
            lower_bin_id,
            upper_bin_id,
            bins,
        })
    }

    /// First bin in the inclusive range.
    pub fn lower_bin_id(&self) -> i32 {
        self.lower_bin_id
    }

    /// Last bin in the inclusive range.
    pub fn upper_bin_id(&self) -> i32 {
        self.upper_bin_id
    }

    /// Liquidity and fee records, ordered from the first bin to the last.
    pub fn bins(&self) -> &[PositionBin] {
        &self.bins
    }
}

fn position_width(lower: i32, upper: i32) -> Result<usize, AccountError> {
    let error = AccountError::InvalidRange { lower, upper };
    let width = i64::from(upper)
        .checked_sub(i64::from(lower))
        .and_then(|difference| difference.checked_add(1))
        .ok_or(error.clone())?;
    let width = usize::try_from(width).map_err(|_| error.clone())?;
    if width == 0 || width > MAX_POSITION_BINS {
        return Err(error);
    }
    Ok(width)
}

fn read_bin(bytes: &[u8], index: usize) -> Result<PositionBin, AccountError> {
    let (share_offset, fees_offset) = if let Some(extended) = index.checked_sub(INLINE_BINS) {
        let start = offset_of(POSITION_BYTES, extended, EXTENDED_BIN_BYTES)?;
        require_length(bytes, offset_of(start, 1, EXTENDED_BIN_BYTES)?)?;
        (start, offset_of(start, 1, EXTENDED_FEES_OFFSET)?)
    } else {
        (
            offset_of(SHARES_OFFSET, index, SHARE_BYTES)?,
            offset_of(FEES_OFFSET, index, FEE_BYTES)?,
        )
    };
    let liquidity_share = reader_at(bytes, share_offset)?.read_u128("liquidity share")?;
    let mut fees = reader_at(bytes, fees_offset)?;
    Ok(PositionBin {
        liquidity_share,
        fees: FeeCheckpoint {
            complete_x: fees.read_u128("fee X checkpoint")?,
            complete_y: fees.read_u128("fee Y checkpoint")?,
            pending_x: RawTokenAmount(u128::from(fees.read_u64("pending fee X")?)),
            pending_y: RawTokenAmount(u128::from(fees.read_u64("pending fee Y")?)),
        },
    })
}
