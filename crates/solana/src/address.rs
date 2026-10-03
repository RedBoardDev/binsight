//! Solana account addresses (public keys), written in base58.
//!
//! An [`Address`] is 32 raw bytes. This module parses and prints the base58 form; it does not
//! check whether the address is on the ed25519 curve or whether an account exists there.

use std::fmt;
use std::str::FromStr;

use crate::base58;
use crate::error::{ParseError, ValueKind};

/// A Solana account address: 32 bytes, shown as base58 text.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Address([u8; 32]);

impl Address {
    /// The number of bytes in an address.
    pub const LENGTH: usize = 32;

    /// The longest base58 text that encodes 32 bytes.
    pub const MAX_BASE58_LENGTH: usize = 44;

    /// An address made of these exact bytes.
    pub const fn from_bytes(bytes: [u8; 32]) -> Self {
        Self(bytes)
    }

    /// The raw bytes of the address.
    pub const fn as_bytes(&self) -> &[u8; 32] {
        &self.0
    }
}

impl FromStr for Address {
    type Err = ParseError;

    /// Parses base58 text such as `"LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9t5PdRXdx"`.
    fn from_str(text: &str) -> Result<Self, Self::Err> {
        base58::decode_exact(text, ValueKind::Address, Self::MAX_BASE58_LENGTH).map(Self)
    }
}

impl fmt::Display for Address {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&base58::encode(&self.0))
    }
}

impl fmt::Debug for Address {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "Address({self})")
    }
}

#[cfg(test)]
mod tests {
    use proptest::prelude::*;

    use super::*;

    #[test]
    fn parses_the_all_zero_address() {
        let address: Address = "11111111111111111111111111111111".parse().unwrap();
        assert_eq!(address.as_bytes(), &[0; 32]);
        assert_eq!(address.to_string(), "11111111111111111111111111111111");
    }

    #[test]
    fn prints_debug_as_base58() {
        let address = Address::from_bytes([0; 32]);
        assert_eq!(
            format!("{address:?}"),
            "Address(11111111111111111111111111111111)"
        );
    }

    #[test]
    fn rejects_text_that_decodes_to_the_wrong_length() {
        let too_short = "1111111111111111111111111111111".parse::<Address>();
        assert_eq!(
            too_short,
            Err(ParseError::WrongLength {
                kind: ValueKind::Address,
                expected: 32,
                found: 31
            })
        );
        let empty = "".parse::<Address>();
        assert!(matches!(
            empty,
            Err(ParseError::WrongLength { found: 0, .. })
        ));
    }

    #[test]
    fn rejects_characters_outside_the_base58_alphabet() {
        for text in [
            "0BUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9t5PdRXdx",
            "OBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9t5PdRXdx",
            "lBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9t5PdRXdx",
            " LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9t5PdRXd",
        ] {
            let result = text.parse::<Address>();
            assert!(
                matches!(result, Err(ParseError::NotBase58 { .. })),
                "{text}: {result:?}"
            );
        }
    }

    #[test]
    fn rejects_overlong_text_before_decoding() {
        let text = "1".repeat(45);
        assert_eq!(
            text.parse::<Address>(),
            Err(ParseError::TooLong {
                kind: ValueKind::Address,
                max_characters: 44
            })
        );
    }

    #[test]
    fn explains_errors_in_plain_words() {
        let error = "1111111111111111111111111111111"
            .parse::<Address>()
            .unwrap_err();
        assert_eq!(
            error.to_string(),
            "the address decodes to 31 bytes instead of 32"
        );
    }

    proptest! {
        #[test]
        fn round_trips_through_base58(bytes: [u8; 32]) {
            let address = Address::from_bytes(bytes);
            let text = address.to_string();
            prop_assert!(text.len() <= Address::MAX_BASE58_LENGTH);
            prop_assert_eq!(text.parse::<Address>(), Ok(address));
        }
    }
}
