//! The real wall clock.
//!
//! This is the only place in binsight that reads the system time: everything else receives a
//! [`Clock`] and can be tested with a fixed one. It does nothing else.

use binsight_core::clock::Clock;
use jiff::Timestamp;

/// The system's wall clock, in UTC.
#[derive(Debug, Clone, Copy, Default)]
pub struct SystemClock;

impl Clock for SystemClock {
    #[expect(
        clippy::disallowed_methods,
        reason = "the one place allowed to read the wall clock"
    )]
    fn now(&self) -> Timestamp {
        Timestamp::now()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_a_time_after_this_code_was_written() {
        let written = Timestamp::from_second(1_790_000_000).unwrap();
        assert!(SystemClock.now() > written);
    }
}
