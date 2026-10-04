//! A progressive delay after failed logins, against password guessing.
//!
//! The first [`FREE_FAILURES`] failures cost nothing; after that each attempt must wait 1, 2, 4...
//! seconds after the last failure, up to [`MAX_DELAY_SECS`]. A success clears the count, and so
//! does an hour without any failure. The count is global rather than per address: there is one
//! owner, and an address is easy to change and meaningless behind a proxy.
//!
//! Checking and counting are one step: an attempt that may go ahead is counted as a failure at
//! once, under the same lock, and forgiven if the password turns out to be right. Otherwise
//! attempts sent at the same moment would all pass the check before the first failure is
//! counted. Time is always passed in, so the rules are tested without waiting. This module
//! counts; it does not check passwords.

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
    /// Starts an attempt at `now`, or says how long it must wait.
    ///
    /// An attempt that may go ahead is already counted as a failure; call
    /// [`LoginAttempt::succeed`] if the password is right.
    pub(crate) fn begin_attempt(&self, now: Timestamp) -> Result<LoginAttempt<'_>, RetryAfter> {
        let mut history = self.lock();
        let current = history.as_of(now);
        if let Some(allowed_at) = current.next_attempt_at()
            && now < allowed_at
        {
            return Err(retry_after(allowed_at, now));
        }
        *history = FailureHistory {
            failures: current.failures.saturating_add(1),
            last_failure: Some(now),
        };
        Ok(LoginAttempt { throttle: self })
    }

    /// The history; a poisoned lock still holds a valid count, so it is reused.
    fn lock(&self) -> MutexGuard<'_, FailureHistory> {
        self.history.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

/// An attempt allowed by the throttle, counted as a failure unless it succeeds.
#[derive(Debug)]
#[must_use = "an attempt stays counted as a failure unless `succeed` is called"]
pub(crate) struct LoginAttempt<'throttle> {
    throttle: &'throttle LoginThrottle,
}

impl LoginAttempt<'_> {
    /// The password was right: clears the count.
    pub(crate) fn succeed(self) {
        *self.throttle.lock() = FailureHistory::default();
    }
}

/// The wait until `allowed_at`, rounded up to the second (at least 1).
fn retry_after(allowed_at: Timestamp, now: Timestamp) -> RetryAfter {
    let wait = allowed_at.duration_since(now);
    let rounded_up = wait
        .as_secs()
        .saturating_add(i64::from(wait.subsec_nanos() > 0));
    RetryAfter(rounded_up.max(1))
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Barrier};

    use super::*;

    fn at(seconds: i64) -> Timestamp {
        Timestamp::from_second(seconds).unwrap()
    }

    fn fail(throttle: &LoginThrottle, times: u32, now: Timestamp) {
        for _ in 0..times {
            drop(throttle.begin_attempt(now).unwrap());
        }
    }

    fn check(throttle: &LoginThrottle, now: Timestamp) -> Result<(), RetryAfter> {
        throttle.begin_attempt(now).map(LoginAttempt::succeed)
    }

    #[test]
    fn lets_the_first_three_failures_through_without_delay() {
        let throttle = LoginThrottle::default();
        fail(&throttle, 3, at(100));
        assert_eq!(throttle.begin_attempt(at(100)).unwrap_err(), RetryAfter(1));
    }

    #[test]
    fn doubles_the_delay_after_each_further_failure_up_to_a_minute() {
        let throttle = LoginThrottle::default();
        fail(&throttle, 3, at(100));
        fail(&throttle, 1, at(101));
        fail(&throttle, 1, at(103));
        assert_eq!(throttle.begin_attempt(at(103)).unwrap_err(), RetryAfter(4));
        assert_eq!(throttle.begin_attempt(at(106)).unwrap_err(), RetryAfter(1));
        assert!(throttle.begin_attempt(at(107)).is_ok());

        for second in [115, 131, 163] {
            fail(&throttle, 1, at(second));
        }
        assert_eq!(throttle.begin_attempt(at(163)).unwrap_err(), RetryAfter(60));
    }

    #[test]
    fn rounds_a_partial_second_up() {
        let throttle = LoginThrottle::default();
        fail(&throttle, 3, at(100));
        fail(&throttle, 1, at(101));
        let half_second_later = Timestamp::new(101, 500_000_000).unwrap();
        assert_eq!(
            throttle.begin_attempt(half_second_later).unwrap_err(),
            RetryAfter(2)
        );
    }

    #[test]
    fn forgets_failures_after_a_quiet_hour() {
        let throttle = LoginThrottle::default();
        fail(&throttle, 3, at(100));
        fail(&throttle, 1, at(101));
        assert!(throttle.begin_attempt(at(102)).is_err());
        fail(&throttle, 3, at(101 + 3_600));
        assert_eq!(check(&throttle, at(101 + 3_600)), Err(RetryAfter(1)));
    }

    #[test]
    fn clears_the_count_after_a_success() {
        let throttle = LoginThrottle::default();
        fail(&throttle, 2, at(100));
        throttle.begin_attempt(at(100)).unwrap().succeed();
        fail(&throttle, 3, at(100));
        assert!(throttle.begin_attempt(at(100)).is_err());
    }

    #[test]
    fn lets_only_the_free_attempts_through_when_many_arrive_at_once() {
        let throttle = Arc::new(LoginThrottle::default());
        let start = Arc::new(Barrier::new(32));
        let attempts: Vec<_> = (0..32)
            .map(|_| {
                let throttle = Arc::clone(&throttle);
                let start = Arc::clone(&start);
                std::thread::spawn(move || {
                    start.wait();
                    throttle.begin_attempt(at(100)).is_ok()
                })
            })
            .collect();

        let allowed = attempts
            .into_iter()
            .map(|attempt| attempt.join().unwrap())
            .filter(|is_allowed| *is_allowed)
            .count();

        assert_eq!(allowed, 3);
    }
}
