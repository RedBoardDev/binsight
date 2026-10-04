//! The identity of the Meteora DLMM program on Solana mainnet, and the tag of its events.
//!
//! This module only names the program and how its events are marked; decoding its accounts and
//! events comes later, in other modules of this crate.

use binsight_solana::Address;

/// The address of the Meteora DLMM program, `LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo`.
///
/// Every DLMM pool, position and event belongs to this program. There is one address on mainnet
/// for every version of the program.
pub const PROGRAM_ID: Address = Address::from_bytes([
    4, 233, 225, 47, 188, 132, 232, 38, 201, 50, 204, 233, 226, 100, 12, 206, 21, 89, 12, 28, 98,
    115, 176, 146, 87, 8, 186, 59, 133, 32, 176, 188,
]);

/// The first 8 bytes of the data of every event the program emits.
///
/// The program emits its events as an inner instruction to itself (Anchor "event CPI"), whose data
/// is this tag, then the 8-byte discriminator of the event, then its Borsh-encoded fields. The
/// tag is Anchor's `EVENT_IX_TAG`, the little-endian bytes of the first 8 bytes of
/// `sha256("anchor:event")` read as a big-endian number.
pub const EVENT_IX_TAG: [u8; 8] = [0xe4, 0x45, 0xa5, 0x2e, 0x51, 0xcb, 0x9a, 0x1d];

#[cfg(test)]
mod tests {
    use sha2::{Digest, Sha256};

    use super::*;

    #[test]
    fn the_program_id_is_the_mainnet_dlmm_program() {
        assert_eq!(
            PROGRAM_ID.to_string(),
            "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo"
        );
    }

    #[test]
    fn the_event_tag_is_the_reversed_prefix_of_the_anchor_event_hash() {
        let hash = Sha256::digest(b"anchor:event");
        let mut expected: [u8; 8] = hash[..8].try_into().unwrap();
        expected.reverse();
        assert_eq!(EVENT_IX_TAG, expected);
    }
}
