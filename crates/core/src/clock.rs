//! An injectable source of the current time.
//!
//! Code that needs "now" receives a [`Clock`] instead of reading the system time, so tests can
//! fix and move time precisely. This module defines the trait and a manual clock for tests; the
//! real wall clock is implemented once, in the engine, and is the only place allowed to read it.

use std::sync::{Mutex, PoisonError};

use jiff::{SignedDuration, Timestamp};

/// A source of the current time.
pub trait Clock: Send + Sync {
    /// The current instant, in UTC.
    fn now(&self) -> Timestamp;
}

/// A clock that only moves when told to, for tests.
#[derive(Debug)]
pub struct FixedClock {
    current: Mutex<Timestamp>,
}

impl FixedClock {
    /// A clock stopped at `start`.
    pub fn new(start: Timestamp) -> Self {
        Self {
            current: Mutex::new(start),
        }
    }

    /// Moves the clock to `instant` (forwards or backwards).
    pub fn set(&self, instant: Timestamp) {
        *self.lock() = instant;
    }

    /// Moves the clock forwards (or backwards, with a negative duration) by `duration`.
    ///
    /// # Errors
    ///
    /// Returns an error, and leaves the clock unchanged, if the new instant would fall outside the
    /// range of [`Timestamp`].
    pub fn advance(&self, duration: SignedDuration) -> Result<(), jiff::Error> {
        let mut current = self.lock();
        *current = current.checked_add(duration)?;
        Ok(())
    }

    /// Locks the current instant. A poisoned lock still holds a valid instant, so it is reused.
    fn lock(&self) -> std::sync::MutexGuard<'_, Timestamp> {
        self.current.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

impl Clock for FixedClock {
    fn now(&self) -> Timestamp {
        *self.lock()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stays_where_it_was_set() {
        let clock = FixedClock::new(Timestamp::UNIX_EPOCH);
        assert_eq!(clock.now(), Timestamp::UNIX_EPOCH);
        assert_eq!(clock.now(), Timestamp::UNIX_EPOCH);

        let later = Timestamp::from_second(1_800_000_000).unwrap();
        clock.set(later);
        assert_eq!(clock.now(), later);
    }

    #[test]
    fn advances_by_the_given_duration() {
        let clock = FixedClock::new(Timestamp::UNIX_EPOCH);
        clock.advance(SignedDuration::from_secs(15)).unwrap();
        assert_eq!(clock.now(), Timestamp::from_second(15).unwrap());
        clock.advance(SignedDuration::from_secs(-5)).unwrap();
        assert_eq!(clock.now(), Timestamp::from_second(10).unwrap());
    }

    #[test]
    fn refuses_to_leave_the_supported_range_and_stays_put() {
        let clock = FixedClock::new(Timestamp::MAX);
        assert!(clock.advance(SignedDuration::from_secs(1)).is_err());
        assert_eq!(clock.now(), Timestamp::MAX);
    }

    #[test]
    fn can_be_shared_as_a_trait_object() {
        let clock: std::sync::Arc<dyn Clock> =
            std::sync::Arc::new(FixedClock::new(Timestamp::UNIX_EPOCH));
        assert_eq!(clock.now(), Timestamp::UNIX_EPOCH);
    }
}
