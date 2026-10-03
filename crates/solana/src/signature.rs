//! Solana transaction signatures, written in base58.
//!
//! A [`Signature`] is 64 raw bytes and identifies a transaction. This module parses and prints the
//! base58 form; it does not verify the signature cryptographically.

use std::fmt;
use std::str::FromStr;

use crate::base58;
use crate::error::{ParseError, ValueKind};

/// A Solana transaction signature: 64 bytes, shown as base58 text.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Signature([u8; 64]);

impl Signature {
    /// The number of bytes in a signature.
    pub const LENGTH: usize = 64;

    /// The longest base58 text that encodes 64 bytes.
    pub const MAX_BASE58_LENGTH: usize = 88;

    /// A signature made of these exact bytes.
    pub const fn from_bytes(bytes: [u8; 64]) -> Self {
        Self(bytes)
    }

    /// The raw bytes of the signature.
    pub const fn as_bytes(&self) -> &[u8; 64] {
        &self.0
    }
}

impl FromStr for Signature {
    type Err = ParseError;

    /// Parses base58 text as returned by Solana RPC nodes.
    fn from_str(text: &str) -> Result<Self, Self::Err> {
        base58::decode_exact(text, ValueKind::Signature, Self::MAX_BASE58_LENGTH).map(Self)
    }
}

impl fmt::Display for Signature {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&base58::encode(&self.0))
    }
}

impl fmt::Debug for Signature {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "Signature({self})")
    }
}

#[cfg(test)]
mod tests {
    use proptest::prelude::*;

    use super::*;

    #[test]
    fn parses_the_all_zero_signature() {
        let text = "1".repeat(64);
        let signature: Signature = text.parse().unwrap();
        assert_eq!(signature.as_bytes(), &[0; 64]);
        assert_eq!(signature.to_string(), text);
    }

    #[test]
    fn rejects_an_address_given_as_a_signature() {
        let result = "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9t5PdRXdx".parse::<Signature>();
        assert_eq!(
            result,
            Err(ParseError::WrongLength {
                kind: ValueKind::Signature,
                expected: 64,
                found: 32
            })
        );
    }

    #[test]
    fn rejects_characters_outside_the_base58_alphabet() {
        let text = format!("{}0", "1".repeat(63));
        assert!(matches!(
            text.parse::<Signature>(),
            Err(ParseError::NotBase58 {
                kind: ValueKind::Signature,
                ..
            })
        ));
    }

    #[test]
    fn rejects_overlong_text_before_decoding() {
        let text = "1".repeat(89);
        assert_eq!(
            text.parse::<Signature>(),
            Err(ParseError::TooLong {
                kind: ValueKind::Signature,
                max_characters: 88
            })
        );
    }

    proptest! {
        #[test]
        fn round_trips_through_base58(bytes in prop::collection::vec(any::<u8>(), 64)) {
            let bytes: [u8; 64] = bytes.try_into().unwrap();
            let signature = Signature::from_bytes(bytes);
            let text = signature.to_string();
            prop_assert!(text.len() <= Signature::MAX_BASE58_LENGTH);
            prop_assert_eq!(text.parse::<Signature>(), Ok(signature));
        }
    }
}
