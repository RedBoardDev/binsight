//! A clock that follows tokio's clock from a fixed start.
//!
//! Workers sleep on tokio's clock and date their work with the injected [`Clock`]. In a test on
//! paused time, tokio's clock jumps ahead whenever every task waits; this clock jumps with it, so
//! a task scheduled "in 30 seconds" falls due when the worker wakes up 30 seconds later.

use binsight_core::clock::Clock;
use jiff::{SignedDuration, Timestamp};
use tokio::time::Instant;

/// A clock that reads `start` plus the time tokio's clock moved since it was created.
#[derive(Debug, Clone, Copy)]
pub struct TokioClock {
    start: Timestamp,
    origin: Instant,
}

impl TokioClock {
    /// A clock that reads `start` now, and moves with tokio's clock.
    pub fn starting_at(start: Timestamp) -> Self {
        Self {
            start,
            origin: Instant::now(),
        }
    }
}

impl Clock for TokioClock {
    fn now(&self) -> Timestamp {
        SignedDuration::try_from(self.origin.elapsed())
            .ok()
            .and_then(|elapsed| self.start.checked_add(elapsed).ok())
            .unwrap_or(Timestamp::MAX)
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;

    #[tokio::test(start_paused = true)]
    async fn moves_with_paused_time() {
        let start = Timestamp::from_second(1_790_000_000).unwrap();
        let clock = TokioClock::starting_at(start);

        tokio::time::sleep(Duration::from_secs(90)).await;

        assert_eq!(clock.now().as_second(), 1_790_000_090);
    }
}
