//! The failed logins of one client, or of all of them, and the delay they impose.
//!
//! A [`DelayPolicy`] lets a number of failures through for free; after that each attempt must
//! wait 1, 2, 4... seconds after the last failure, up to a maximum. An hour without any failure
//! forgets them all. This module computes; it holds no lock and reads no clock.

use jiff::{SignedDuration, Timestamp};

/// After this long without a failure, past failures are forgotten.
const FORGET_AFTER_SECS: i64 = 3_600;

/// How many failures cost nothing, and the longest delay the others can impose.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct DelayPolicy {
    /// Failures allowed before any delay.
    pub(crate) free_failures: u32,
    /// The longest delay between two attempts.
    pub(crate) max_delay_secs: i64,
}

/// The failed attempts that count.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct FailureHistory {
    failures: u32,
    last_failure: Option<Timestamp>,
}

impl FailureHistory {
    /// The history as it counts at `now`: empty once the failures are old enough.
    pub(crate) fn as_of(self, now: Timestamp) -> Self {
        let forget_after = SignedDuration::from_secs(FORGET_AFTER_SECS);
        match self.last_failure {
            Some(last) if now.duration_since(last) >= forget_after => Self::default(),
            _ => self,
        }
    }

    /// Whether no failure counts any more.
    pub(crate) fn is_empty(self) -> bool {
        self.failures == 0
    }

    /// The history with one more failure at `now`.
    pub(crate) fn with_failure(self, now: Timestamp) -> Self {
        Self {
            failures: self.failures.saturating_add(1),
            last_failure: Some(now),
        }
    }

    /// The history with one failure less: an attempt counted in advance that succeeded.
    pub(crate) fn without_one_failure(self) -> Self {
        Self {
            failures: self.failures.saturating_sub(1),
            ..self
        }
    }

    /// When the next attempt is allowed under `policy`, if it has to wait at all.
    pub(crate) fn next_attempt_at(self, policy: DelayPolicy) -> Option<Timestamp> {
        let last = self.last_failure?;
        let paid_failures = self.failures.checked_sub(policy.free_failures)?;
        let delay = 2_i64
            .checked_pow(paid_failures)
            .map_or(policy.max_delay_secs, |seconds| {
                seconds.min(policy.max_delay_secs)
            });
        last.checked_add(SignedDuration::from_secs(delay)).ok()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const POLICY: DelayPolicy = DelayPolicy {
        free_failures: 3,
        max_delay_secs: 60,
    };

    fn at(seconds: i64) -> Timestamp {
        Timestamp::from_second(seconds).unwrap()
    }

    fn failures(count: u32, now: Timestamp) -> FailureHistory {
        (0..count).fold(FailureHistory::default(), |history, _| {
            history.with_failure(now)
        })
    }

    #[test]
    fn imposes_no_delay_for_the_free_failures() {
        assert_eq!(failures(2, at(100)).next_attempt_at(POLICY), None);
        assert_eq!(failures(3, at(100)).next_attempt_at(POLICY), Some(at(101)));
    }

    #[test]
    fn doubles_the_delay_after_each_further_failure_up_to_the_maximum() {
        assert_eq!(failures(5, at(100)).next_attempt_at(POLICY), Some(at(104)));
        assert_eq!(failures(9, at(100)).next_attempt_at(POLICY), Some(at(160)));
        assert_eq!(failures(99, at(100)).next_attempt_at(POLICY), Some(at(160)));
    }

    #[test]
    fn forgets_the_failures_after_a_quiet_hour() {
        let history = failures(9, at(100));

        assert_eq!(history.as_of(at(100 + 3_599)), history);
        assert!(history.as_of(at(100 + 3_600)).is_empty());
    }

    #[test]
    fn takes_back_a_failure_counted_in_advance() {
        let history = failures(3, at(100)).without_one_failure();

        assert_eq!(history.next_attempt_at(POLICY), None);
    }
}
