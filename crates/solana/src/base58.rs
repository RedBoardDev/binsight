//! Base58 decoding into fixed-size byte arrays, shared by addresses and signatures.
//!
//! This module checks the length of the text before decoding it, so an oversized input cannot make
//! the decoder work for long. It knows nothing about what the bytes mean.

use crate::error::{ParseError, ValueKind};

/// Decodes `text` into exactly `N` bytes.
///
/// `max_characters` is the longest base58 text that can encode `N` bytes; longer texts are refused
/// without being decoded.
pub(crate) fn decode_exact<const N: usize>(
    text: &str,
    kind: ValueKind,
    max_characters: usize,
) -> Result<[u8; N], ParseError> {
    if text.len() > max_characters {
        return Err(ParseError::TooLong {
            kind,
            max_characters,
        });
    }
    let bytes = bs58::decode(text)
        .into_vec()
        .map_err(|source| ParseError::NotBase58 { kind, source })?;
    <[u8; N]>::try_from(bytes.as_slice()).map_err(|_| ParseError::WrongLength {
        kind,
        expected: N,
        found: bytes.len(),
    })
}

/// Encodes bytes as base58 text.
pub(crate) fn encode(bytes: &[u8]) -> String {
    bs58::encode(bytes).into_string()
}
