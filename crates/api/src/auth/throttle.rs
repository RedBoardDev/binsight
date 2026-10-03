//! A progressive delay after failed logins, against password guessing.
//!
//! The first [`FREE_FAILURES`] failures cost nothing; after that each attempt must wait 1, 2, 4...
//! seconds after the last failure, up to [`MAX_DELAY_SECS`]. A success clears the count, and so
//! does an hour without any failure. The count is global rather than per address: there is one
//! owner, and an address is easy to change and meaningless behind a proxy. Time is always passed
//! in, so the rules are tested without waiting. This module counts; it does not check passwords.

use std::sync::{Mutex, MutexGuard, PoisonError};

use jiff::{SignedDuration, Timestamp};

/// Failures allowed before any delay.
const FREE_FAILURES: u32 = 3;

/// The longest delay between two attempts.
const MAX_DELAY_SECS: i64 = 60;

/// After this long without a failure, past failures are forgotten.
const FORGET_AFTER_SECS: i64 = 3_600;

/// How long to wait before the next attempt, in whole seconds (at least 1).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct RetryAfter(pub(crate) i64);

/// The failed attempts that count.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
struct FailureHistory {
    failures: u32,
    last_failure: Option<Timestamp>,
}

impl FailureHistory {
    /// The history as it counts at `now`: empty once the failures are old enough.
    fn as_of(self, now: Timestamp) -> Self {
        let forget_after = SignedDuration::from_secs(FORGET_AFTER_SECS);
        match self.last_failure {
            Some(last) if now.duration_since(last) >= forget_after => Self::default(),
            _ => self,
        }
    }

    /// When the next attempt is allowed, if it has to wait at all.
    fn next_attempt_at(self) -> Option<Timestamp> {
        let last = self.last_failure?;
        let paid_failures = self.failures.checked_sub(FREE_FAILURES)?;
        let delay = 2_i64
            .checked_pow(paid_failures)
            .map_or(MAX_DELAY_SECS, |seconds| seconds.min(MAX_DELAY_SECS));
        last.checked_add(SignedDuration::from_secs(delay)).ok()
    }
}

/// The shared count of failed logins.
#[derive(Debug, Default)]
pub(crate) struct LoginThrottle {
    history: Mutex<FailureHistory>,
}

impl LoginThrottle {
    /// Whether an attempt may be made at `now`, or how long it must wait.
    pub(crate) fn check(&self, now: Timestamp) -> Result<(), RetryAfter> {
        let Some(allowed_at) = self.lock().as_of(now).next_attempt_at() else {
            return Ok(());
        };
        if now >= allowed_at {
            return Ok(());
        }
        let wait = allowed_at.duration_since(now);
        let rounded_up = wait
            .as_secs()
            .saturating_add(i64::from(wait.subsec_nanos() > 0));
        Err(RetryAfter(rounded_up.max(1)))
    }

    /// Counts a wrong password tried at `now`.
    pub(crate) fn record_failure(&self, now: Timestamp) {
        let mut history = self.lock();
        let current = history.as_of(now);
        *history = FailureHistory {
            failures: current.failures.saturating_add(1),
            last_failure: Some(now),
        };
    }

    /// Clears the count after a successful login.
    pub(crate) fn record_success(&self) {
        *self.lock() = FailureHistory::default();
    }

    /// The history; a poisoned lock still holds a valid count, so it is reused.
    fn lock(&self) -> MutexGuard<'_, FailureHistory> {
        self.history.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(seconds: i64) -> Timestamp {
        Timestamp::from_second(seconds).unwrap()
    }

    fn fail(throttle: &LoginThrottle, times: u32, now: Timestamp) {
        for _ in 0..times {
            throttle.record_failure(now);
        }
    }

    #[test]
    fn lets_the_first_three_failures_through_without_delay() {
        let throttle = LoginThrottle::default();
        fail(&throttle, 2, at(100));
        assert_eq!(throttle.check(at(100)), Ok(()));
        fail(&throttle, 1, at(100));
        assert_eq!(throttle.check(at(100)), Err(RetryAfter(1)));
    }

    #[test]
    fn doubles_the_delay_after_each_further_failure_up_to_a_minute() {
        let throttle = LoginThrottle::default();
        fail(&throttle, 5, at(100));
        assert_eq!(throttle.check(at(100)), Err(RetryAfter(4)));
        assert_eq!(throttle.check(at(103)), Err(RetryAfter(1)));
        assert_eq!(throttle.check(at(104)), Ok(()));

        fail(&throttle, 20, at(200));
        assert_eq!(throttle.check(at(200)), Err(RetryAfter(60)));
    }

    #[test]
    fn rounds_a_partial_second_up() {
        let throttle = LoginThrottle::default();
        fail(&throttle, 4, at(100));
        let half_second_later = Timestamp::new(100, 500_000_000).unwrap();
        assert_eq!(throttle.check(half_second_later), Err(RetryAfter(2)));
    }

    #[test]
    fn forgets_failures_after_a_quiet_hour() {
        let throttle = LoginThrottle::default();
        fail(&throttle, 10, at(100));
        assert_eq!(throttle.check(at(100 + 3_600)), Ok(()));
        throttle.record_failure(at(100 + 3_600));
        assert_eq!(throttle.check(at(100 + 3_600)), Ok(()));
    }

    #[test]
    fn clears_the_count_after_a_success() {
        let throttle = LoginThrottle::default();
        fail(&throttle, 10, at(100));
        throttle.record_success();
        assert_eq!(throttle.check(at(100)), Ok(()));
    }
}
