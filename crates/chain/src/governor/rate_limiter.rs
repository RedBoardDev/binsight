//! Pacing requests evenly at a steady rate.
//!
//! Each request is due one interval after the previous one, with no burst: the provider counts
//! requests over short windows, and a burst on top of the steady rate is exactly what it refuses.
//! A caller books the next free slot, then waits for it without holding the lock, so nothing
//! reserves more than one slot at a time. After a 429 every caller pauses for as long as the
//! provider asked, including the ones already waiting for a slot: a caller that wakes up to find
//! a pause started meanwhile books a new slot after it. The clock is tokio's, so tests run it
//! paused. This module only paces; the rate comes from the plan, and credits are counted
//! elsewhere.

use std::sync::{Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use tokio::time::{Instant, sleep_until};

/// Paces requests to a steady rate.
#[derive(Debug)]
pub(crate) struct RateLimiter {
    interval: Duration,
    slots: Mutex<Slots>,
}

#[derive(Debug, Default)]
struct Slots {
    /// When the next request may go; `None` before the first one.
    next_due: Option<Instant>,
    /// Until when the provider asked every request to wait, if it did.
    paused_until: Option<Instant>,
}

impl RateLimiter {
    /// A limiter that lets `requests_per_second` requests through each second (at least one),
    /// evenly spaced.
    pub(crate) fn new(requests_per_second: u32) -> Self {
        let interval = Duration::from_secs(1)
            .checked_div(requests_per_second.max(1))
            .unwrap_or(Duration::from_secs(1));
        Self {
            interval,
            slots: Mutex::new(Slots::default()),
        }
    }

    /// Waits until a request may be sent.
    pub(crate) async fn acquire(&self) {
        loop {
            let due = self.book_slot();
            sleep_until(due).await;
            if !self.pause_started_before(due) {
                return;
            }
        }
    }

    /// Holds every request back for `pause`, the ones already waiting included.
    pub(crate) fn cool_down(&self, pause: Duration) {
        let Some(resume) = Instant::now().checked_add(pause) else {
            return;
        };
        let mut slots = self.lock();
        slots.paused_until = Some(slots.paused_until.map_or(resume, |until| until.max(resume)));
        slots.next_due = Some(slots.next_due.map_or(resume, |due| due.max(resume)));
    }

    /// Books the next free slot, after any pause, and returns when it is due.
    fn book_slot(&self) -> Instant {
        let mut slots = self.lock();
        let now = Instant::now();
        let due = [slots.next_due, slots.paused_until]
            .into_iter()
            .flatten()
            .fold(now, Instant::max);
        slots.next_due = Some(due.checked_add(self.interval).unwrap_or(due));
        due
    }

    /// Whether a pause that started after the slot `due` was booked still covers it.
    fn pause_started_before(&self, due: Instant) -> bool {
        self.lock().paused_until.is_some_and(|until| until > due)
    }

    fn lock(&self) -> MutexGuard<'_, Slots> {
        self.slots.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::*;

    #[tokio::test(start_paused = true)]
    async fn spaces_requests_evenly_without_a_burst() {
        let limiter = RateLimiter::new(5);
        let started = Instant::now();

        for _ in 0..6 {
            limiter.acquire().await;
        }

        assert_eq!(started.elapsed(), Duration::from_secs(1));
    }

    #[tokio::test(start_paused = true)]
    async fn holds_every_request_back_after_a_rate_limit() {
        let limiter = RateLimiter::new(5);
        limiter.acquire().await;
        let started = Instant::now();

        limiter.cool_down(Duration::from_secs(2));
        limiter.acquire().await;
        let first = started.elapsed();
        limiter.acquire().await;

        assert_eq!(first, Duration::from_secs(2));
        assert_eq!(started.elapsed(), Duration::from_millis(2_200));
    }

    #[tokio::test(start_paused = true)]
    async fn respects_retry_after_and_pauses_the_callers_already_waiting() {
        let limiter = Arc::new(RateLimiter::new(5));
        limiter.acquire().await;
        let started = Instant::now();
        let mut waiting = Vec::new();
        for _ in 0..4 {
            let limiter = limiter.clone();
            waiting.push(tokio::spawn(async move {
                limiter.acquire().await;
                started.elapsed()
            }));
        }
        for _ in 0..4 {
            tokio::task::yield_now().await;
        }

        limiter.cool_down(Duration::from_secs(3));
        let mut sent_at = Vec::new();
        for caller in waiting {
            sent_at.push(caller.await.unwrap());
        }

        sent_at.sort();
        let expected: Vec<Duration> = [3_000, 3_200, 3_400, 3_600]
            .into_iter()
            .map(Duration::from_millis)
            .collect();
        assert_eq!(sent_at, expected);
    }

    #[tokio::test(start_paused = true)]
    async fn allows_at_least_one_request_per_second() {
        let limiter = RateLimiter::new(0);
        let started = Instant::now();

        limiter.acquire().await;
        limiter.acquire().await;

        assert_eq!(started.elapsed(), Duration::from_secs(1));
    }
}
