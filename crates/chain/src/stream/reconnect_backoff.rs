//! How long the stream waits before opening a connection again.
//!
//! The wait starts at one second and doubles after each connection that failed or did not last,
//! up to thirty seconds, with a quarter of jitter either way so many instances do not reconnect
//! in step. A connection that stayed healthy for a minute resets it. The jitter comes from the
//! attempt count rather than a random generator, so tests are deterministic. This module is
//! pure.

use std::time::Duration;

/// The first wait.
const FIRST_WAIT_MILLIS: u64 = 1_000;

/// The longest wait.
const LONGEST_WAIT_MILLIS: u64 = 30_000;

/// The jitter, in percent of the wait, on either side.
const JITTER_PERCENT: u64 = 25;

/// How long a connection must last for the wait to start again from one second.
pub(crate) const HEALTHY_CONNECTION: Duration = Duration::from_mins(1);

/// The waits between connection attempts.
#[derive(Debug, Default)]
pub(crate) struct ReconnectBackoff {
    failures_in_a_row: u32,
}

impl ReconnectBackoff {
    /// The wait after a connection that lasted `lasted` (zero if it never opened).
    pub(crate) fn after(&mut self, lasted: Duration) -> Duration {
        if lasted >= HEALTHY_CONNECTION {
            self.failures_in_a_row = 0;
        }
        let doublings = self.failures_in_a_row;
        self.failures_in_a_row = self.failures_in_a_row.saturating_add(1);
        let wait = 2_u64
            .checked_pow(doublings)
            .and_then(|factor| factor.checked_mul(FIRST_WAIT_MILLIS))
            .map_or(LONGEST_WAIT_MILLIS, |millis| {
                millis.min(LONGEST_WAIT_MILLIS)
            });
        let spread = wait.saturating_mul(JITTER_PERCENT) / 100;
        let width = spread.saturating_mul(2).saturating_add(1);
        let seed = u64::from(self.failures_in_a_row).wrapping_mul(0x9E37_79B9_7F4A_7C15);
        let offset = (seed ^ (seed >> 31)) % width;
        Duration::from_millis(wait.saturating_sub(spread).saturating_add(offset))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn doubles_the_wait_from_one_second_up_to_thirty_with_jitter() {
        let mut backoff = ReconnectBackoff::default();

        let waits: Vec<Duration> = (0..7).map(|_| backoff.after(Duration::ZERO)).collect();

        for (wait, base) in waits.iter().zip([1, 2, 4, 8, 16, 30, 30]) {
            let base = Duration::from_secs(base);
            assert!(*wait >= base * 3 / 4 && *wait <= base * 5 / 4, "{wait:?}");
        }
    }

    #[test]
    fn starts_again_from_one_second_after_a_healthy_connection() {
        let mut backoff = ReconnectBackoff::default();
        for _ in 0..5 {
            backoff.after(Duration::ZERO);
        }

        let wait = backoff.after(HEALTHY_CONNECTION);

        assert!(wait <= Duration::from_millis(1_250), "{wait:?}");
    }
}
