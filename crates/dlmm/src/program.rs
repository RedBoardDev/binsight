//! The identity of the Meteora DLMM program on Solana mainnet, and how its events are marked.
//!
//! This module only names the program, its event authority and its event tag; decoding the
//! events is the job of [`crate::event`].

use binsight_solana::Address;

/// The address of the Meteora DLMM program, `LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo`.
///
/// Every DLMM pool, position and event belongs to this program. There is one address on mainnet
/// for every version of the program.
pub const PROGRAM_ID: Address = Address::from_bytes([
    4, 233, 225, 47, 188, 132, 232, 38, 201, 50, 204, 233, 226, 100, 12, 206, 21, 89, 12, 28, 98,
    115, 176, 146, 87, 8, 186, 59, 133, 32, 176, 188,
]);

/// The account that signs every event the program emits,
/// `D1ZN9Wj1fRSUQfCjhvnu1hqDMT7hzjzBBpi12nVniYD6`.
///
/// It is the program's address derived from the seed `__event_authority`. Only the program can
/// sign for it, so an instruction to the program that carries the event tag but not this account
/// is not an event.
pub const EVENT_AUTHORITY: Address = Address::from_bytes([
    178, 112, 214, 127, 169, 140, 81, 207, 2, 19, 5, 19, 88, 150, 43, 175, 53, 116, 43, 237, 89,
    201, 217, 68, 94, 156, 13, 12, 133, 199, 205, 145,
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
    fn the_event_authority_is_the_one_that_signs_mainnet_events() {
        assert_eq!(
            EVENT_AUTHORITY.to_string(),
            "D1ZN9Wj1fRSUQfCjhvnu1hqDMT7hzjzBBpi12nVniYD6"
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
