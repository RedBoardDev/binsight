//! A cursor over a byte slice that reads little-endian integers and Solana's compact-u16.
//!
//! Transactions and instruction data are untrusted bytes, so every read checks that the bytes are
//! there and returns [`MalformedBytes`] otherwise, instead of panicking. This module knows nothing
//! about what the bytes mean.

use crate::Address;
use crate::error::MalformedBytes;

/// Reads values one after the other from a byte slice.
#[derive(Debug)]
pub(crate) struct ByteReader<'a> {
    bytes: &'a [u8],
    offset: usize,
}

/// How far each byte of a compact-u16 (7 bits per byte, at most 3 bytes) is shifted.
const COMPACT_U16_SHIFTS: [u32; 3] = [0, 7, 14];

/// The bit that says another byte of the compact-u16 follows.
const COMPACT_U16_CONTINUATION: u8 = 0x80;

impl<'a> ByteReader<'a> {
    /// A reader positioned at the first byte of `bytes`.
    pub(crate) fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, offset: 0 }
    }

    /// How many bytes have been read so far.
    pub(crate) fn offset(&self) -> usize {
        self.offset
    }

    /// How many bytes are left.
    fn remaining(&self) -> usize {
        self.bytes.len().saturating_sub(self.offset)
    }

    /// Refuses bytes left after the last value read.
    pub(crate) fn finish(&self, what: &'static str) -> Result<(), MalformedBytes> {
        match self.remaining() {
            0 => Ok(()),
            count => Err(MalformedBytes::TrailingBytes { what, count }),
        }
    }

    /// The next `length` bytes.
    pub(crate) fn read_bytes(
        &mut self,
        length: usize,
        what: &'static str,
    ) -> Result<&'a [u8], MalformedBytes> {
        let end = MalformedBytes::UnexpectedEnd {
            what,
            offset: self.offset,
        };
        let stop = self.offset.checked_add(length).ok_or(end)?;
        let bytes = self.bytes.get(self.offset..stop).ok_or(end)?;
        self.offset = stop;
        Ok(bytes)
    }

    /// The next `N` bytes as an array.
    pub(crate) fn read_array<const N: usize>(
        &mut self,
        what: &'static str,
    ) -> Result<[u8; N], MalformedBytes> {
        let offset = self.offset;
        let bytes = self.read_bytes(N, what)?;
        <[u8; N]>::try_from(bytes).map_err(|_| MalformedBytes::UnexpectedEnd { what, offset })
    }

    /// The next byte, without moving past it.
    pub(crate) fn peek_u8(&self, what: &'static str) -> Result<u8, MalformedBytes> {
        self.bytes
            .get(self.offset)
            .copied()
            .ok_or(MalformedBytes::UnexpectedEnd {
                what,
                offset: self.offset,
            })
    }

    /// One byte.
    pub(crate) fn read_u8(&mut self, what: &'static str) -> Result<u8, MalformedBytes> {
        self.read_array::<1>(what).map(u8::from_le_bytes)
    }

    /// A little-endian `u16`.
    pub(crate) fn read_u16(&mut self, what: &'static str) -> Result<u16, MalformedBytes> {
        self.read_array(what).map(u16::from_le_bytes)
    }

    /// A little-endian `u32`.
    pub(crate) fn read_u32(&mut self, what: &'static str) -> Result<u32, MalformedBytes> {
        self.read_array(what).map(u32::from_le_bytes)
    }

    /// A little-endian `u64`.
    pub(crate) fn read_u64(&mut self, what: &'static str) -> Result<u64, MalformedBytes> {
        self.read_array(what).map(u64::from_le_bytes)
    }

    /// A 32-byte address.
    pub(crate) fn read_address(&mut self, what: &'static str) -> Result<Address, MalformedBytes> {
        self.read_array(what).map(Address::from_bytes)
    }

    /// A compact-u16: 7 bits per byte, low bits first, at most 3 bytes, in its shortest form
    /// (the rules the Solana runtime applies, so a value it would refuse is refused here too).
    pub(crate) fn read_compact_u16(&mut self, what: &'static str) -> Result<u16, MalformedBytes> {
        let invalid = MalformedBytes::InvalidCompactU16 {
            what,
            offset: self.offset,
        };
        let mut value: u32 = 0;
        for (position, shift) in COMPACT_U16_SHIFTS.into_iter().enumerate() {
            let byte = self.read_u8(what)?;
            let is_longer_than_needed = byte == 0 && position > 0;
            if is_longer_than_needed {
                return Err(invalid);
            }
            let bits = u32::from(byte & !COMPACT_U16_CONTINUATION);
            value |= bits.checked_shl(shift).ok_or(invalid)?;
            if byte & COMPACT_U16_CONTINUATION == 0 {
                return u16::try_from(value).map_err(|_| invalid);
            }
        }
        Err(invalid)
    }
}

#[cfg(test)]
mod tests {
    use proptest::prelude::*;

    use super::*;

    /// The compact-u16 encoding, written here only to check the reader against it.
    fn encode_compact_u16(mut value: u16) -> Vec<u8> {
        let mut bytes = Vec::new();
        loop {
            let low = u8::try_from(value & 0x7f).unwrap();
            value >>= 7;
            if value == 0 {
                bytes.push(low);
                return bytes;
            }
            bytes.push(low | 0x80);
        }
    }

    #[test]
    fn reads_little_endian_integers_in_order() {
        let bytes = [1, 2, 0, 3, 0, 0, 0, 4, 0, 0, 0, 0, 0, 0, 0];
        let mut reader = ByteReader::new(&bytes);
        assert_eq!(reader.read_u8("a"), Ok(1));
        assert_eq!(reader.read_u16("b"), Ok(2));
        assert_eq!(reader.read_u32("c"), Ok(3));
        assert_eq!(reader.read_u64("d"), Ok(4));
        assert_eq!(reader.remaining(), 0);
    }

    #[test]
    fn reports_where_the_bytes_ran_out() {
        let mut reader = ByteReader::new(&[1, 2]);
        reader.read_u8("first").unwrap();
        assert_eq!(
            reader.read_u32("the amount"),
            Err(MalformedBytes::UnexpectedEnd {
                what: "the amount",
                offset: 1
            })
        );
    }

    #[test]
    fn refuses_a_compact_u16_that_is_not_in_its_shortest_form() {
        let mut reader = ByteReader::new(&[0x80, 0x00]);
        assert_eq!(
            reader.read_compact_u16("a count"),
            Err(MalformedBytes::InvalidCompactU16 {
                what: "a count",
                offset: 0
            })
        );
    }

    #[test]
    fn refuses_a_compact_u16_above_u16_max_or_longer_than_3_bytes() {
        let too_large = [0xff, 0xff, 0x04];
        assert!(ByteReader::new(&too_large).read_compact_u16("a").is_err());
        let too_long = [0x80, 0x80, 0x80, 0x01];
        assert!(ByteReader::new(&too_long).read_compact_u16("a").is_err());
    }

    proptest! {
        #[test]
        fn compact_u16_round_trips(value: u16) {
            let bytes = encode_compact_u16(value);
            let mut reader = ByteReader::new(&bytes);
            prop_assert_eq!(reader.read_compact_u16("a value"), Ok(value));
            prop_assert_eq!(reader.remaining(), 0);
        }
    }
}
