//! Pool-scoped bin snapshots and lookup by the program's floor-divided array index.

use std::collections::BTreeMap;

use binsight_core::units::RawTokenAmount;
use binsight_solana::Address;

use super::{
    AccountError,
    reading::{check_discriminator, offset_of, reader_at, require_length},
};

/// Number of consecutive bins held in one bin array account.
pub const BINS_PER_ARRAY: i32 = 70;
const BIN_COUNT: usize = 70;
const DISCRIMINATOR: [u8; 8] = [92, 142, 92, 220, 5, 148, 70, 181];
const BINS_OFFSET: usize = 56;
const BIN_BYTES: usize = 144;
const ARRAY_BYTES: usize = 10_136;
const FEES_OFFSET: usize = 80;

/// A bin's liquidity-owned balances and cumulative fee accumulators.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Bin {
    /// Raw X balance, excluding protocol fees and limit orders.
    pub amount_x: RawTokenAmount,
    /// Raw Y balance, excluding protocol fees and limit orders.
    pub amount_y: RawTokenAmount,
    /// Total Q64.64 liquidity supply.
    pub liquidity_supply: u128,
    /// Cumulative X fees per unit of liquidity.
    pub fee_x_per_token: u128,
    /// Cumulative Y fees per unit of liquidity.
    pub fee_y_per_token: u128,
}

/// The 70 consecutive bins belonging to one pool and array index.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BinArray {
    index: i64,
    lb_pair: Address,
    bins: Vec<Bin>,
}

impl BinArray {
    /// Decodes the complete bin array account.
    ///
    /// # Errors
    /// Refuses an unknown discriminator or any truncated bin record.
    pub fn decode(bytes: &[u8]) -> Result<Self, AccountError> {
        check_discriminator(bytes, DISCRIMINATOR, "bin array")?;
        require_length(bytes, ARRAY_BYTES)?;
        let index = i64::from_le_bytes(reader_at(bytes, 8)?.read_array("bin array index")?);
        let lb_pair = reader_at(bytes, 24)?.read_address("bin array pool")?;
        let mut bins = Vec::with_capacity(BIN_COUNT);
        for index in 0..BIN_COUNT {
            bins.push(read_bin(bytes, offset_of(BINS_OFFSET, index, BIN_BYTES)?)?);
        }
        Ok(Self {
            index,
            lb_pair,
            bins,
        })
    }

    /// Array index encoded in the account.
    pub fn index(&self) -> i64 {
        self.index
    }

    /// Pool encoded in the account.
    pub fn lb_pair(&self) -> Address {
        self.lb_pair
    }

    /// Reads a bin only when it belongs to this array.
    pub fn bin(&self, bin_id: i32) -> Option<&Bin> {
        if bin_array_index(bin_id) != self.index {
            return None;
        }
        let offset = usize::try_from(bin_id.rem_euclid(BINS_PER_ARRAY)).ok()?;
        self.bins.get(offset)
    }
}

/// Available bin arrays from one pool; absent arrays stay explicitly absent.
#[derive(Debug, Clone)]
pub struct BinLookup {
    lb_pair: Address,
    arrays: BTreeMap<i64, BinArray>,
}

impl BinLookup {
    /// Binds decoded arrays to a pool, without silently replacing duplicates.
    ///
    /// # Errors
    /// Refuses arrays from another pool and duplicate indices.
    pub fn new(lb_pair: Address, arrays: Vec<BinArray>) -> Result<Self, AccountError> {
        let mut lookup = BTreeMap::new();
        for array in arrays {
            if array.lb_pair != lb_pair {
                return Err(AccountError::WrongPool {
                    expected: lb_pair,
                    actual: array.lb_pair,
                });
            }
            let index = array.index;
            if lookup.insert(index, array).is_some() {
                return Err(AccountError::DuplicateBinArray(index));
            }
        }
        Ok(Self {
            lb_pair,
            arrays: lookup,
        })
    }

    /// The pool whose arrays this lookup contains.
    pub fn lb_pair(&self) -> Address {
        self.lb_pair
    }

    /// A bin when its array was included in the snapshot.
    pub fn bin(&self, bin_id: i32) -> Option<&Bin> {
        self.arrays.get(&bin_array_index(bin_id))?.bin(bin_id)
    }
}

/// The array containing `bin_id`, including floor division for negative bins.
pub fn bin_array_index(bin_id: i32) -> i64 {
    i64::from(bin_id.div_euclid(BINS_PER_ARRAY))
}

fn read_bin(bytes: &[u8], offset: usize) -> Result<Bin, AccountError> {
    let mut balances = reader_at(bytes, offset)?;
    let amount_x = RawTokenAmount(u128::from(balances.read_u64("bin X amount")?));
    let amount_y = RawTokenAmount(u128::from(balances.read_u64("bin Y amount")?));
    balances.read_u128("bin price")?;
    let liquidity_supply = balances.read_u128("bin liquidity supply")?;
    let mut fees = reader_at(bytes, offset_of(offset, 1, FEES_OFFSET)?)?;
    Ok(Bin {
        amount_x,
        amount_y,
        liquidity_supply,
        fee_x_per_token: fees.read_u128("bin X fee accumulator")?,
        fee_y_per_token: fees.read_u128("bin Y fee accumulator")?,
    })
}
