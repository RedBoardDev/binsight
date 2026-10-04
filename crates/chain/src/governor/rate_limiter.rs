//! Pacing requests evenly at a steady rate, the most urgent first.
//!
//! Each request is due one interval after the previous one, with no burst: the provider counts
//! requests over short windows, and a burst on top of the steady rate is exactly what it refuses.
//! Callers wait in one lane per priority (`waiting_lanes`); each slot goes to the caller served
//! next, so a live request never waits behind the history import. A caller that finds its lane
//! full is told how long to wait instead of joining it, so background work is deferred rather
//! than pushing urgent work into the future. After a 429 every caller pauses for as long as the
//! provider asked, the ones already waiting included.
//!
//! Only the caller served next sleeps on the clock; the others wait to be woken. The clock is
//! tokio's, so tests run it paused. This module only paces; the rate comes from the plan, and
//! credits are counted elsewhere.

use std::sync::{Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use binsight_core::credits::Priority;
use tokio::time::{Instant, sleep_until};

use super::waiting_lanes::{Ticket, WaitingLanes};

/// A caller found its lane full; it should try again after `wait`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct LaneFull {
    /// About how long the callers ahead of it need to be served.
    pub(crate) wait: Duration,
}

/// Paces requests to a steady rate, the most urgent first.
#[derive(Debug)]
pub(crate) struct RateLimiter {
    interval: Duration,
    state: Mutex<Pacing>,
}

#[derive(Debug, Default)]
struct Pacing {
    /// When the next request may go; `None` before the first one.
    next_due: Option<Instant>,
    /// Until when the provider asked every request to wait, if it did.
    paused_until: Option<Instant>,
    /// The callers waiting.
    lanes: WaitingLanes,
}

/// What a waiting caller does next.
enum Turn {
    /// The slot is taken: send the request.
    Served,
    /// Another caller goes first: wait to be woken.
    Behind,
    /// This caller goes next, at this instant.
    DueAt(Instant),
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
            state: Mutex::new(Pacing::default()),
        }
    }

    /// Waits until a request of `priority` may be sent.
    ///
    /// # Errors
    ///
    /// Returns [`LaneFull`] at once, without waiting, if too many callers of `priority` already
    /// wait.
    pub(crate) async fn acquire(&self, priority: Priority) -> Result<(), LaneFull> {
        let ticket = self.lock().lanes.join(priority).map_err(|ahead| LaneFull {
            wait: self
                .interval
                .saturating_mul(u32::try_from(ahead).unwrap_or(u32::MAX)),
        })?;
        let place = Place {
            limiter: self,
            ticket,
        };
        loop {
            match self.take_turn(&place.ticket) {
                Turn::Served => return Ok(()),
                Turn::Behind => place.ticket.wake.notified().await,
                Turn::DueAt(due) => sleep_until(due).await,
            }
        }
    }

    /// Holds every request back for `pause`, the ones already waiting included.
    pub(crate) fn cool_down(&self, pause: Duration) {
        let Some(resume) = Instant::now().checked_add(pause) else {
            return;
        };
        let mut state = self.lock();
        state.paused_until = Some(state.paused_until.map_or(resume, |until| until.max(resume)));
    }

    /// Serves `ticket` if it is served next and its slot has come; otherwise says how to wait.
    fn take_turn(&self, ticket: &Ticket) -> Turn {
        let mut state = self.lock();
        if !state.lanes.is_first(ticket) {
            return Turn::Behind;
        }
        let now = Instant::now();
        let due = [state.next_due, state.paused_until]
            .into_iter()
            .flatten()
            .fold(now, Instant::max);
        if due > now {
            return Turn::DueAt(due);
        }
        state.next_due = Some(now.checked_add(self.interval).unwrap_or(now));
        state.lanes.leave(ticket);
        Turn::Served
    }

    fn lock(&self) -> MutexGuard<'_, Pacing> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

/// A caller's place in its lane; a caller that gives up (its future dropped) leaves it, and
/// whoever is served next is woken.
struct Place<'limiter> {
    limiter: &'limiter RateLimiter,
    ticket: Ticket,
}

impl Drop for Place<'_> {
    fn drop(&mut self) {
        self.limiter.lock().lanes.leave(&self.ticket);
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::*;

    async fn acquire_all(limiter: &RateLimiter, count: usize) {
        for _ in 0..count {
            limiter.acquire(Priority::History).await.unwrap();
        }
    }

    /// Starts `count` callers of `priority` that report how long after `started` they were
    /// served, and lets them all join their lane.
    async fn waiting_callers(
        limiter: &Arc<RateLimiter>,
        priority: Priority,
        count: usize,
        started: Instant,
    ) -> Vec<tokio::task::JoinHandle<Duration>> {
        let callers: Vec<_> = (0..count)
            .map(|_| {
                let limiter = limiter.clone();
                tokio::spawn(async move {
                    limiter.acquire(priority).await.unwrap();
                    started.elapsed()
                })
            })
            .collect();
        for _ in 0..count {
            tokio::task::yield_now().await;
        }
        callers
    }

    async fn served_at(callers: Vec<tokio::task::JoinHandle<Duration>>) -> Vec<u128> {
        let mut served = Vec::new();
        for caller in callers {
            served.push(caller.await.unwrap().as_millis());
        }
        served.sort_unstable();
        served
    }

    #[tokio::test(start_paused = true)]
    async fn spaces_requests_evenly_without_a_burst() {
        let limiter = RateLimiter::new(5);
        let started = Instant::now();

        acquire_all(&limiter, 6).await;

        assert_eq!(started.elapsed(), Duration::from_secs(1));
    }

    #[tokio::test(start_paused = true)]
    async fn holds_every_request_back_after_a_rate_limit() {
        let limiter = RateLimiter::new(5);
        acquire_all(&limiter, 1).await;
        let started = Instant::now();

        limiter.cool_down(Duration::from_secs(2));
        acquire_all(&limiter, 1).await;
        let first = started.elapsed();
        acquire_all(&limiter, 1).await;

        assert_eq!(first, Duration::from_secs(2));
        assert_eq!(started.elapsed(), Duration::from_millis(2_200));
    }

    #[tokio::test(start_paused = true)]
    async fn respects_retry_after_and_pauses_every_lane() {
        let limiter = Arc::new(RateLimiter::new(5));
        acquire_all(&limiter, 1).await;
        let started = Instant::now();
        let mut callers = waiting_callers(&limiter, Priority::History, 2, started).await;
        callers.extend(waiting_callers(&limiter, Priority::Realtime, 2, started).await);

        limiter.cool_down(Duration::from_secs(3));

        assert_eq!(served_at(callers).await, [3_000, 3_200, 3_400, 3_600]);
    }

    #[tokio::test(start_paused = true)]
    async fn serves_realtime_calls_before_waiting_history_calls() {
        let limiter = Arc::new(RateLimiter::new(5));
        acquire_all(&limiter, 1).await;
        let started = Instant::now();
        let history = waiting_callers(&limiter, Priority::History, 3, started).await;

        let realtime = waiting_callers(&limiter, Priority::Realtime, 2, started).await;

        assert_eq!(served_at(realtime).await, [200, 400]);
        assert_eq!(served_at(history).await, [600, 800, 1_000]);
    }

    #[tokio::test(start_paused = true)]
    async fn defers_history_instead_of_pushing_live_calls_into_the_future() {
        let limiter = Arc::new(RateLimiter::new(5));
        acquire_all(&limiter, 1).await;
        let started = Instant::now();
        let history = waiting_callers(&limiter, Priority::History, 32, started).await;

        let refused = limiter.acquire(Priority::History).await;
        let realtime = waiting_callers(&limiter, Priority::Realtime, 1, started).await;

        assert_eq!(
            refused,
            Err(LaneFull {
                wait: Duration::from_millis(6_400)
            })
        );
        assert_eq!(served_at(realtime).await, [200]);
        assert_eq!(served_at(history).await.len(), 32);
    }

    #[tokio::test(start_paused = true)]
    async fn lets_the_next_caller_go_when_the_first_one_gives_up() {
        let limiter = Arc::new(RateLimiter::new(5));
        acquire_all(&limiter, 1).await;
        let started = Instant::now();
        let first = waiting_callers(&limiter, Priority::Realtime, 1, started).await;
        let second = waiting_callers(&limiter, Priority::History, 1, started).await;

        for caller in first {
            caller.abort();
        }

        assert_eq!(served_at(second).await, [200]);
    }

    #[tokio::test(start_paused = true)]
    async fn allows_at_least_one_request_per_second() {
        let limiter = RateLimiter::new(0);
        let started = Instant::now();

        acquire_all(&limiter, 2).await;

        assert_eq!(started.elapsed(), Duration::from_secs(1));
    }
}
