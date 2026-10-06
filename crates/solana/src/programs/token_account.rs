//! The amount a token account holds, read from the account's data.
//!
//! SPL Token and Token-2022 accounts share their base layout: the mint (32 bytes), the owner (32
//! bytes), then the amount, a little-endian `u64`. Those eight bytes are enough to compare an
//! account with what the registry last saw of it, and a request can ask the node for them alone
//! ([`AMOUNT_OFFSET`], [`AMOUNT_LENGTH`]). This module reads the amount; it does not judge it.

use binsight_core::units::RawTokenAmount;

/// Where the amount starts in a token account's data.
pub const AMOUNT_OFFSET: usize = 64;

/// How many bytes the amount takes.
pub const AMOUNT_LENGTH: usize = 8;

/// The amount held by a token account, from the [`AMOUNT_LENGTH`] bytes of its data at
/// [`AMOUNT_OFFSET`]; `None` if `bytes` is not exactly that long (the account is not a token
/// account, or the node returned something else).
pub fn amount_from_slice(bytes: &[u8]) -> Option<RawTokenAmount> {
    let amount = <[u8; AMOUNT_LENGTH]>::try_from(bytes).ok()?;
    Some(RawTokenAmount(u128::from(u64::from_le_bytes(amount))))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_a_little_endian_amount() {
        let bytes = 1_000_000_u64.to_le_bytes();

        assert_eq!(amount_from_slice(&bytes), Some(RawTokenAmount(1_000_000)));
        assert_eq!(
            amount_from_slice(&u64::MAX.to_le_bytes()),
            Some(RawTokenAmount(u128::from(u64::MAX)))
        );
    }

    #[test]
    fn reads_nothing_from_a_slice_of_another_length() {
        assert_eq!(amount_from_slice(&[]), None);
        assert_eq!(amount_from_slice(&[0; 9]), None);
    }
}
