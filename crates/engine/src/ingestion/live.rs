//! Live detection: what the stream reports, and when each wallet is listed again.
//!
//! The listener (`live_listener`) turns the stream's events into work: a signature it reports is
//! recorded and fetched at once, without waiting for a listing, and its wallet's next check is
//! brought forward; a confirmed subscription asks for a top-up; a disconnection makes the checks
//! frequent until the stream is back. The listing worker reads the same [`LiveState`] to decide
//! which wallet to list again and when (`check_schedule`). The stream never moves a cursor: only
//! a listing raises a wallet's top.

mod check_schedule;
mod live_listener;
mod wallet_checks;

pub(super) use check_schedule::NextCheck;
pub(super) use live_listener::run_live_listener;
pub(super) use wallet_checks::{CheckReason, STARTUP_GRACE};

use std::sync::{Mutex, MutexGuard, PoisonError};

use binsight_chain::StreamEvent;
use binsight_core::credits::Priority;
use binsight_solana::Address;
use binsight_store::TrackedWallet;
use jiff::Timestamp;
use tokio::sync::Notify;

use check_schedule::CheckSchedule;

/// What the listener learns from the stream and the workers act on.
#[derive(Debug)]
pub(super) struct LiveState {
    started_at: Timestamp,
    checks: Mutex<CheckSchedule>,
    changed: Notify,
}

impl LiveState {
    /// The state of an engine started at `started_at`, before the stream connects.
    pub(super) fn new(started_at: Timestamp) -> Self {
        Self {
            started_at,
            checks: Mutex::new(CheckSchedule::new(started_at)),
            changed: Notify::new(),
        }
    }

    /// Waits until the state changes.
    pub(super) async fn changed(&self) {
        self.changed.notified().await;
    }

    /// Wakes the worker waiting for a change.
    pub(super) fn notify_changed(&self) {
        self.changed.notify_one();
    }

    /// Whether startup has waited long enough for the subscriptions before listing anything:
    /// every wallet is subscribed, or the grace period is over. Listing only after subscribing
    /// leaves no gap between what the listing sees and what the stream reports.
    pub(super) fn is_startup_settled(&self, wallets: &[TrackedWallet], now: Timestamp) -> bool {
        let checks = self.lock();
        let grace_over = self
            .started_at
            .checked_add(STARTUP_GRACE)
            .is_ok_and(|end| now >= end);
        grace_over
            || wallets
                .iter()
                .all(|wallet| checks.is_subscribed(wallet.address))
    }

    /// When the startup grace ends.
    pub(super) fn startup_grace_end(&self) -> Timestamp {
        self.started_at
            .checked_add(STARTUP_GRACE)
            .unwrap_or(Timestamp::MAX)
    }

    /// The next check among `wallets` of `least_urgent` or a more urgent class, at `now`.
    pub(super) fn next_check(
        &self,
        wallets: &[TrackedWallet],
        least_urgent: Priority,
        now: Timestamp,
    ) -> NextCheck {
        self.lock().next(wallets, least_urgent, now)
    }

    /// Takes in what the stream reported at `now`.
    pub(super) fn apply(&self, event: &StreamEvent, now: Timestamp) {
        let mut checks = self.lock();
        match event {
            StreamEvent::Disconnected { .. } => checks.stream_down(now),
            StreamEvent::Subscribed { wallet } => checks.subscribed(*wallet, now),
            StreamEvent::SubscriptionRefused { wallet, .. } => {
                checks.unsubscribed(*wallet, now);
            }
            StreamEvent::Activity(activity) => checks.activity(activity.wallet, now),
            StreamEvent::Overflowed => checks.events_lost(now),
            StreamEvent::Connected | StreamEvent::ServerError { .. } => {}
        }
        drop(checks);
        self.notify_changed();
    }

    /// A listing of `wallet` from its newest signature started at `started_at` and was written.
    pub(super) fn checked(&self, wallet: Address, started_at: Timestamp) {
        self.lock().checked(wallet, started_at);
    }

    /// A check of `wallet` failed at `now`; returns how many in a row, and when it is tried
    /// again.
    pub(super) fn check_failed(&self, wallet: Address, now: Timestamp) -> (u32, Timestamp) {
        self.lock().failed(wallet, now)
    }

    /// Since when `wallet`'s subscription is down, if it is, and whether its check is late, at
    /// `now`.
    pub(super) fn lag(&self, wallet: Address, now: Timestamp) -> (Option<Timestamp>, bool) {
        self.lock().lag(wallet, now)
    }

    fn lock(&self) -> MutexGuard<'_, CheckSchedule> {
        self.checks.lock().unwrap_or_else(PoisonError::into_inner)
    }
}
