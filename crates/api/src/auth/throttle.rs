//! A progressive delay after failed logins, against password guessing.
//!
//! Failures are counted per client address: the first [`PER_CLIENT`] failures of an address
//! cost nothing, then each of its attempts must wait 1, 2, 4... seconds after its last failure,
//! up to a minute. Someone guessing from one address therefore cannot lock the owner out from
//! another. Failures from every address also count together against a much larger allowance,
//! [`ALL_CLIENTS`], so guessing from many addresses at once is slowed down too. A success clears
//! the count of its address, and an hour without any failure forgets them.
//!
//! Checking and counting are one step: an attempt that may go ahead is counted as a failure at
//! once, under the same lock, and forgiven if the password turns out to be right. Otherwise
//! attempts sent at the same moment would all pass the check before the first failure is
//! counted. Addresses are forgotten after their quiet hour, and the backstop bounds how many
//! failures an hour can bring, so the table stays small. Time is always passed in, so the rules
//! are tested without waiting. This module counts; it does not check passwords.

mod failure_history;

use std::collections::HashMap;
use std::sync::{Mutex, MutexGuard, PoisonError};

use jiff::Timestamp;

use super::client_address::ClientKey;
use failure_history::{DelayPolicy, FailureHistory};

/// The allowance of each client address.
const PER_CLIENT: DelayPolicy = DelayPolicy {
    free_failures: 3,
    max_delay_secs: 60,
};

/// The allowance of every client address together: a backstop against guessing from many
/// addresses, generous enough that the owner rarely meets it.
const ALL_CLIENTS: DelayPolicy = DelayPolicy {
    free_failures: 30,
    max_delay_secs: 60,
};

/// How long to wait before the next attempt, in whole seconds (at least 1).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct RetryAfter(pub(crate) i64);

/// The failed logins, per client address and in total.
#[derive(Debug, Default)]
struct Failures {
    per_client: HashMap<ClientKey, FailureHistory>,
    all_clients: FailureHistory,
}

impl Failures {
    /// Drops the failures that no longer count at `now`.
    fn forget_old(&mut self, now: Timestamp) {
        self.per_client
            .retain(|_, history| !history.as_of(now).is_empty());
        self.all_clients = self.all_clients.as_of(now);
    }
}

/// The shared count of failed logins.
#[derive(Debug, Default)]
pub(crate) struct LoginThrottle {
    failures: Mutex<Failures>,
}

impl LoginThrottle {
    /// Starts an attempt from `client` at `now`, or says how long it must wait.
    ///
    /// An attempt that may go ahead is already counted as a failure; call
    /// [`LoginAttempt::succeed`] if the password is right.
    pub(crate) fn begin_attempt(
        &self,
        client: ClientKey,
        now: Timestamp,
    ) -> Result<LoginAttempt<'_>, RetryAfter> {
        let mut failures = self.lock();
        failures.forget_old(now);
        let history = failures
            .per_client
            .get(&client)
            .copied()
            .unwrap_or_default();
        let allowed_at = [
            history.next_attempt_at(PER_CLIENT),
            failures.all_clients.next_attempt_at(ALL_CLIENTS),
        ]
        .into_iter()
        .flatten()
        .max();
        if let Some(allowed_at) = allowed_at
            && now < allowed_at
        {
            return Err(retry_after(allowed_at, now));
        }
        failures
            .per_client
            .insert(client, history.with_failure(now));
        failures.all_clients = failures.all_clients.with_failure(now);
        Ok(LoginAttempt {
            throttle: self,
            client,
        })
    }

    /// The counts; a poisoned lock still holds valid counts, so they are reused.
    fn lock(&self) -> MutexGuard<'_, Failures> {
        self.failures.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

/// An attempt allowed by the throttle, counted as a failure unless it succeeds.
#[derive(Debug)]
#[must_use = "an attempt stays counted as a failure unless `succeed` is called"]
pub(crate) struct LoginAttempt<'throttle> {
    throttle: &'throttle LoginThrottle,
    client: ClientKey,
}

impl LoginAttempt<'_> {
    /// The password was right: clears the count of the client and takes this attempt back from
    /// the total.
    pub(crate) fn succeed(self) {
        let mut failures = self.throttle.lock();
        failures.per_client.remove(&self.client);
        failures.all_clients = failures.all_clients.without_one_failure();
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
    use std::net::{IpAddr, Ipv4Addr};
    use std::sync::{Arc, Barrier};

    use super::*;

    const OWNER: ClientKey = ClientKey::Address(IpAddr::V4(Ipv4Addr::new(192, 0, 2, 1)));
    const GUESSER: ClientKey = ClientKey::Address(IpAddr::V4(Ipv4Addr::new(198, 51, 100, 7)));

    fn at(seconds: i64) -> Timestamp {
        Timestamp::from_second(seconds).unwrap()
    }

    fn client(number: u8) -> ClientKey {
        ClientKey::Address(IpAddr::V4(Ipv4Addr::new(203, 0, 113, number)))
    }

    fn fail(throttle: &LoginThrottle, client: ClientKey, times: u32, now: Timestamp) {
        for _ in 0..times {
            drop(throttle.begin_attempt(client, now).unwrap());
        }
    }

    #[test]
    fn delays_a_client_after_its_three_free_failures() {
        let throttle = LoginThrottle::default();
        fail(&throttle, GUESSER, 3, at(100));

        assert_eq!(
            throttle.begin_attempt(GUESSER, at(100)).unwrap_err(),
            RetryAfter(1)
        );
        assert!(throttle.begin_attempt(GUESSER, at(101)).is_ok());
    }

    #[test]
    fn rounds_a_partial_second_up() {
        let throttle = LoginThrottle::default();
        fail(&throttle, GUESSER, 3, at(100));
        fail(&throttle, GUESSER, 1, at(101));
        let half_second_later = Timestamp::new(101, 500_000_000).unwrap();

        assert_eq!(
            throttle
                .begin_attempt(GUESSER, half_second_later)
                .unwrap_err(),
            RetryAfter(2)
        );
    }

    #[test]
    fn never_delays_a_client_for_the_failures_of_another() {
        let throttle = LoginThrottle::default();
        fail(&throttle, GUESSER, 3, at(100));
        fail(&throttle, GUESSER, 1, at(101));

        let attempt = throttle.begin_attempt(OWNER, at(101));

        assert!(attempt.is_ok());
    }

    #[test]
    fn delays_every_client_once_all_of_them_failed_too_often() {
        let throttle = LoginThrottle::default();
        for number in 0..30 {
            fail(&throttle, client(number), 1, at(100));
        }

        assert_eq!(
            throttle.begin_attempt(OWNER, at(100)).unwrap_err(),
            RetryAfter(1)
        );
    }

    #[test]
    fn clears_the_count_of_a_client_after_its_success() {
        let throttle = LoginThrottle::default();
        fail(&throttle, OWNER, 2, at(100));
        throttle.begin_attempt(OWNER, at(100)).unwrap().succeed();

        fail(&throttle, OWNER, 3, at(100));

        assert!(throttle.begin_attempt(OWNER, at(100)).is_err());
    }

    #[test]
    fn forgets_a_client_after_a_quiet_hour() {
        let throttle = LoginThrottle::default();
        fail(&throttle, GUESSER, 3, at(100));
        fail(&throttle, OWNER, 1, at(100 + 3_600));

        assert_eq!(throttle.lock().per_client.len(), 1);
        assert!(throttle.begin_attempt(GUESSER, at(100 + 3_600)).is_ok());
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
                    throttle.begin_attempt(GUESSER, at(100)).is_ok()
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
