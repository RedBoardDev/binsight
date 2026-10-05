//! Deterministic randomness: one stream of numbers per entity of the demo world.
//!
//! The generator is `SplitMix64`, written here so that the sequence can never change with a
//! dependency update (the demo world and its tests must stay the same). Each entity (a wallet, a
//! pool, a position) draws from its own stream, derived from the seed and a label, so adding a
//! wallet does not change the others. Bounded draws use a 128-bit multiply, never a cast.

use sha2::{Digest, Sha256};

/// A stream of pseudo-random numbers.
#[derive(Debug, Clone)]
pub(crate) struct Stream {
    state: u64,
}

/// The increment of `SplitMix64` (the golden ratio in 64 bits).
const GOLDEN_GAMMA: u64 = 0x9E37_79B9_7F4A_7C15;

impl Stream {
    /// The stream of the entity named `label` in the world of `seed`.
    pub(crate) fn of(seed: u64, label: &str) -> Self {
        let digest = Sha256::new()
            .chain_update(seed.to_le_bytes())
            .chain_update(label.as_bytes())
            .finalize();
        let mut state = [0_u8; 8];
        for (byte, source) in state.iter_mut().zip(digest.iter()) {
            *byte = *source;
        }
        Self {
            state: u64::from_le_bytes(state),
        }
    }

    /// The next 64 random bits.
    pub(crate) fn next_u64(&mut self) -> u64 {
        self.state = self.state.wrapping_add(GOLDEN_GAMMA);
        let mut mixed = self.state;
        mixed = (mixed ^ (mixed >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        mixed = (mixed ^ (mixed >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        mixed ^ (mixed >> 31)
    }

    /// A number in `0..bound` (`0` when `bound` is zero).
    pub(crate) fn below(&mut self, bound: u64) -> u64 {
        let wide = u128::from(self.next_u64()).wrapping_mul(u128::from(bound));
        u64::try_from(wide >> 64).unwrap_or(0)
    }

    /// A number in `low..=high` (`low` when the range is empty).
    pub(crate) fn between(&mut self, low: i64, high: i64) -> i64 {
        let width = high.abs_diff(low).saturating_add(1);
        let offset = i64::try_from(self.below(width)).unwrap_or(0);
        low.saturating_add(offset).min(high.max(low))
    }

    /// Whether an event of probability `percent` % happens.
    pub(crate) fn chance(&mut self, percent: u64) -> bool {
        self.below(100) < percent
    }

    /// A number in `low..=high` whose logarithm is uniform: small values are as likely as large
    /// ones in proportion (sizes of positions). Drawn by picking a decade-like band first.
    pub(crate) fn log_uniform(&mut self, low: i64, high: i64) -> i64 {
        let mut ceiling = high;
        while ceiling > low.saturating_mul(2) && self.chance(50) {
            ceiling = ceiling.saturating_div(2);
        }
        self.between(low, ceiling.max(low))
    }

    /// The larger of two uniform draws in `low..=high`: later values are more likely, with a
    /// density that grows linearly (activity growing towards today).
    pub(crate) fn rising(&mut self, low: i64, high: i64) -> i64 {
        self.between(low, high).max(self.between(low, high))
    }
}

/// A cheap, stateless random value for item `index` of the sequence named by `seed`: the
/// `SplitMix64` output at that position. Used where one value per minute is needed on demand.
pub(crate) fn mixed(seed: u64, index: u64) -> u64 {
    let mut stream = Stream {
        state: seed.wrapping_add(index.wrapping_mul(GOLDEN_GAMMA)),
    };
    stream.next_u64()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gives_the_same_sequence_for_the_same_seed_and_label() {
        let mut first = Stream::of(7, "wallet:Main");
        let mut second = Stream::of(7, "wallet:Main");
        let mut other = Stream::of(7, "wallet:Degen");
        let (a, b, c) = (first.next_u64(), second.next_u64(), other.next_u64());
        assert_eq!(a, b);
        assert_ne!(a, c);
    }

    #[test]
    fn matches_the_reference_splitmix64_output() {
        // SplitMix64 seeded with 0 gives 0xE220A8397B1DCDAF first (reference implementation).
        let mut stream = Stream { state: 0 };
        assert_eq!(stream.next_u64(), 0xE220_A839_7B1D_CDAF);
    }

    #[test]
    fn stays_within_its_bounds() {
        let mut stream = Stream::of(1, "bounds");
        for _ in 0..1_000 {
            let value = stream.between(-5, 5);
            assert!((-5..=5).contains(&value));
            assert!(stream.below(3) < 3);
            let size = stream.log_uniform(10, 1_000);
            assert!((10..=1_000).contains(&size));
        }
        assert_eq!(stream.below(0), 0);
        assert_eq!(stream.between(4, 4), 4);
    }
}
