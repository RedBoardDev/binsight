//! The signatures already reported per wallet, so each one is reported once.
//!
//! A server may deliver a notification twice (at least once, around a reconnection). A signature
//! is remembered per wallet: one transaction that mentions two watched wallets is news to both.
//! The memory is bounded: past [`RECENT_SIGNATURE_CAPACITY`] the oldest is forgotten, which at
//! worst reports an old signature again, and the registry ignores a signature it already holds.
//! This module is pure.

use std::collections::{HashSet, VecDeque};

use binsight_solana::{Address, Signature};

/// How many `(wallet, signature)` pairs are remembered.
const RECENT_SIGNATURE_CAPACITY: usize = 10_000;

/// The `(wallet, signature)` pairs reported lately, the oldest first.
#[derive(Debug, Default)]
pub(crate) struct RecentSignatures {
    order: VecDeque<(Address, Signature)>,
    known: HashSet<(Address, Signature)>,
}

impl RecentSignatures {
    /// Remembers `signature` for `wallet`; returns whether it is new.
    pub(crate) fn remember(&mut self, wallet: Address, signature: Signature) -> bool {
        if !self.known.insert((wallet, signature)) {
            return false;
        }
        self.order.push_back((wallet, signature));
        if self.order.len() > RECENT_SIGNATURE_CAPACITY
            && let Some(oldest) = self.order.pop_front()
        {
            self.known.remove(&oldest);
        }
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reports_each_signature_once_per_wallet() {
        let mut recent = RecentSignatures::default();
        let signature = Signature::from_bytes([5; 64]);
        let wallet = Address::from_bytes([1; 32]);
        let other = Address::from_bytes([2; 32]);

        assert!(recent.remember(wallet, signature));
        assert!(!recent.remember(wallet, signature));
        assert!(recent.remember(other, signature));
    }

    #[test]
    fn forgets_the_oldest_signature_past_its_capacity() {
        let mut recent = RecentSignatures::default();
        let wallet = Address::from_bytes([1; 32]);
        let numbered = |number: usize| {
            let mut bytes = [0; 64];
            bytes[..8].copy_from_slice(&number.to_le_bytes());
            Signature::from_bytes(bytes)
        };
        for number in 0..=RECENT_SIGNATURE_CAPACITY {
            recent.remember(wallet, numbered(number));
        }

        assert!(recent.remember(wallet, numbered(0)));
        assert!(!recent.remember(wallet, numbered(RECENT_SIGNATURE_CAPACITY)));
    }
}
