//! Telling a quiet connection from a dead one.
//!
//! A quiet wallet is normal, so silence proves nothing; a half-open connection, on the other
//! hand, looks connected forever. So the stream sends a protocol ping every 30 seconds (which
//! also keeps the provider from closing an idle connection) and expects the pong, or any other
//! frame, within 15 seconds; otherwise the connection is dead. This module only keeps the
//! deadlines; the supervisor sends the pings and closes the connection.

use std::time::Duration;

use tokio::time::Instant;

/// How often a ping is sent.
const PING_INTERVAL: Duration = Duration::from_secs(30);

/// How long the answer to a ping may take.
const PONG_TIMEOUT: Duration = Duration::from_secs(15);

/// What the connection needs now.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum LivenessCheck {
    /// Send a ping.
    Ping,
    /// The last ping went unanswered: the connection is dead.
    Dead,
    /// Nothing until this instant.
    WaitUntil(Instant),
}

/// The ping and pong deadlines of one connection.
#[derive(Debug, Clone, Copy)]
pub(crate) struct Liveness {
    next_ping_at: Instant,
    answer_due_by: Option<Instant>,
}

impl Liveness {
    /// The deadlines of a connection opened at `now`.
    pub(crate) fn new(now: Instant) -> Self {
        Self {
            next_ping_at: now.checked_add(PING_INTERVAL).unwrap_or(now),
            answer_due_by: None,
        }
    }

    /// A frame arrived: the connection is alive.
    pub(crate) fn heard(&mut self) {
        self.answer_due_by = None;
    }

    /// What to do at `now`.
    pub(crate) fn check(&self, now: Instant) -> LivenessCheck {
        match self.answer_due_by {
            Some(due_by) if now >= due_by => LivenessCheck::Dead,
            Some(due_by) => LivenessCheck::WaitUntil(due_by.min(self.next_ping_at)),
            None if now >= self.next_ping_at => LivenessCheck::Ping,
            None => LivenessCheck::WaitUntil(self.next_ping_at),
        }
    }

    /// A ping was sent at `now`.
    pub(crate) fn pinged(&mut self, now: Instant) {
        self.next_ping_at = now.checked_add(PING_INTERVAL).unwrap_or(now);
        self.answer_due_by = Some(now.checked_add(PONG_TIMEOUT).unwrap_or(now));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn after(start: Instant, secs: u64) -> Instant {
        start.checked_add(Duration::from_secs(secs)).unwrap()
    }

    #[test]
    fn pings_every_thirty_seconds_while_answered() {
        let start = Instant::now();
        let mut liveness = Liveness::new(start);

        assert_eq!(
            liveness.check(start),
            LivenessCheck::WaitUntil(after(start, 30))
        );
        assert_eq!(liveness.check(after(start, 30)), LivenessCheck::Ping);
        liveness.pinged(after(start, 30));
        liveness.heard();
        assert_eq!(
            liveness.check(after(start, 31)),
            LivenessCheck::WaitUntil(after(start, 60))
        );
    }

    #[test]
    fn calls_a_connection_dead_fifteen_seconds_after_an_unanswered_ping() {
        let start = Instant::now();
        let mut liveness = Liveness::new(start);

        liveness.pinged(after(start, 30));

        assert_eq!(
            liveness.check(after(start, 44)),
            LivenessCheck::WaitUntil(after(start, 45))
        );
        assert_eq!(liveness.check(after(start, 45)), LivenessCheck::Dead);
    }
}
