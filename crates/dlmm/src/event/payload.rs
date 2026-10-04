//! How an event is written as the JSON payload binsight stores for it.
//!
//! Token amounts are written as decimal strings, never as JSON numbers: a reader that parses
//! numbers as floating point (JavaScript, many SQL functions) would round amounts above 2^53.
//! Addresses are written in base58, as [`binsight_solana::Address`] serializes itself. This module
//! only holds the field writers the event structs name in their `serialize_with` attributes; the
//! shapes are in [`super::contents`].

use binsight_core::units::RawTokenAmount;
use serde::ser::{SerializeMap, SerializeSeq};
use serde::{Serialize, Serializer};

/// Writes an amount as its decimal string.
pub(super) fn amount<S: Serializer>(
    value: &RawTokenAmount,
    serializer: S,
) -> Result<S::Ok, S::Error> {
    serializer.collect_str(&value.0)
}

/// Writes amounts as a list of decimal strings.
pub(super) fn amounts<S: Serializer>(
    values: &[RawTokenAmount; 2],
    serializer: S,
) -> Result<S::Ok, S::Error> {
    let mut list = serializer.serialize_seq(Some(values.len()))?;
    for value in values {
        list.serialize_element(&DecimalText(*value))?;
    }
    list.end()
}

/// An amount that serializes as its decimal string, for the elements of a list.
struct DecimalText(RawTokenAmount);

impl Serialize for DecimalText {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        amount(&self.0, serializer)
    }
}

/// Writes an event discriminator in lowercase hexadecimal.
#[expect(
    clippy::trivially_copy_pass_by_ref,
    reason = "serde hands every field writer a reference"
)]
pub(super) fn discriminator<S: Serializer>(
    value: &[u8; 8],
    serializer: S,
) -> Result<S::Ok, S::Error> {
    serializer.serialize_str(&hex(value))
}

/// `bytes` in lowercase hexadecimal, two digits per byte.
fn hex(bytes: &[u8]) -> String {
    bytes
        .iter()
        .flat_map(|byte| [byte >> 4, byte & 0x0f])
        .filter_map(|nibble| char::from_digit(u32::from(nibble), 16))
        .collect()
}

/// Writes an empty object, for an event whose fields binsight does not read.
pub(super) fn no_fields<S: Serializer, T>(_: &T, serializer: S) -> Result<S::Ok, S::Error> {
    serializer.serialize_map(Some(0))?.end()
}
