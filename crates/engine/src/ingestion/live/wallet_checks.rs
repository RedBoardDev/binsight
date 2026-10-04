//! One wallet's checks: when each kind falls due, and what a listing, activity or the stream
//! change about them.
//!
//! A top-up is owed from a confirmed subscription or lost events until a listing starts after
//! it; a wallet never checked owes its first one a little after startup. Activity is covered by a
//! listing that starts 30 seconds after it, once the transaction is final; until then a check is
//! due when the burst ends, at most two minutes after its first activity and a minute after the
//! last check. The cadence is 15 minutes while subscribed, one otherwise. A failed check holds
//! every check of the wallet back with the shared backoff. This module is pure.

use binsight_core::credits::{Priority, Purpose};
use jiff::{SignedDuration, Timestamp};

use crate::ingestion::failure_backoff::retry_delay;

/// The cadence while the wallet's subscription is live.
const SUBSCRIBED_CADENCE: SignedDuration = SignedDuration::from_mins(15);

/// The cadence while it is not.
const UNSUBSCRIBED_CADENCE: SignedDuration = SignedDuration::from_mins(1);

/// How long after activity its transaction is final and listed.
const ACTIVITY_DELAY: SignedDuration = SignedDuration::from_secs(30);

/// The longest a check waits for a burst of activity to end.
const ACTIVITY_DEBOUNCE_LIMIT: SignedDuration = SignedDuration::from_mins(2);

/// The shortest time between two checks made for activity.
const ACTIVITY_SPACING: SignedDuration = SignedDuration::from_mins(1);

/// How long after startup a wallet the stream never confirmed is topped up anyway.
pub(in crate::ingestion) const STARTUP_GRACE: SignedDuration = SignedDuration::from_secs(10);

/// Why a wallet is listed again.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub(in crate::ingestion) enum CheckReason {
    /// Catching up after the stream could not see: startup, a reconnection, lost events.
    TopUp,
    /// The stream saw activity.
    Activity,
    /// The cadence.
    Cadence,
}

impl CheckReason {
    /// The class of the listing, and of the fetches it queues.
    pub(in crate::ingestion) const fn priority(self) -> Priority {
        match self {
            Self::TopUp => Priority::CatchUp,
            Self::Activity | Self::Cadence => Priority::Realtime,
        }
    }

    /// What its credits are filed under.
    pub(in crate::ingestion) const fn purpose(self) -> Purpose {
        match self {
            Self::TopUp => Purpose::TopUp,
            Self::Activity | Self::Cadence => Purpose::LiveCheck,
        }
    }
}

/// One wallet's checks.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(super) struct WalletChecks {
    is_subscribed: bool,
    /// Since when its subscription is down, once it was up.
    unsubscribed_since: Option<Timestamp>,
    /// When the last listing from the newest signature started.
    last_check_at: Option<Timestamp>,
    /// Since when a top-up is owed.
    top_up_since: Option<Timestamp>,
    /// The first activity no check has covered yet.
    uncovered_activity_at: Option<Timestamp>,
    /// The latest activity.
    last_activity_at: Option<Timestamp>,
    /// How many checks failed in a row, and until when the next one waits.
    failures_in_a_row: u32,
    held_until: Option<Timestamp>,
}

impl WalletChecks {
    /// When each kind of check falls due, for an engine started at `started_at`.
    pub(super) fn due(&self, started_at: Timestamp) -> Vec<(Timestamp, CheckReason)> {
        let mut due = Vec::new();
        match (self.top_up_since, self.last_check_at) {
            (Some(since), _) => due.push((since, CheckReason::TopUp)),
            (None, None) => due.push((later(started_at, STARTUP_GRACE), CheckReason::TopUp)),
            (None, Some(_)) => {}
        }
        if let Some(last_check_at) = self.last_check_at {
            due.push((later(last_check_at, self.cadence()), CheckReason::Cadence));
        }
        if let (Some(first), Some(last)) = (self.uncovered_activity_at, self.last_activity_at) {
            let after_burst =
                later(last, ACTIVITY_DELAY).min(later(first, ACTIVITY_DEBOUNCE_LIMIT));
            let spaced = self
                .last_check_at
                .map_or(after_burst, |checked| later(checked, ACTIVITY_SPACING));
            due.push((after_burst.max(spaced), CheckReason::Activity));
        }
        if let Some(held_until) = self.held_until {
            for (due_at, _) in &mut due {
                *due_at = (*due_at).max(held_until);
            }
        }
        due
    }

    /// A check failed at `now`; returns how many in a row, and when it is tried again.
    pub(super) fn failed(&mut self, now: Timestamp) -> (u32, Timestamp) {
        self.failures_in_a_row = self.failures_in_a_row.saturating_add(1);
        let retry_at = later(now, retry_delay(self.failures_in_a_row));
        self.held_until = Some(retry_at);
        (self.failures_in_a_row, retry_at)
    }

    /// A listing from the newest signature started at `started_at` and was written.
    pub(super) fn checked(&mut self, started_at: Timestamp) {
        self.last_check_at = Some(started_at);
        self.failures_in_a_row = 0;
        self.held_until = None;
        if self.top_up_since.is_some_and(|since| since <= started_at) {
            self.top_up_since = None;
        }
        let is_covered = |activity_at: Timestamp| later(activity_at, ACTIVITY_DELAY) <= started_at;
        self.uncovered_activity_at = match (self.uncovered_activity_at, self.last_activity_at) {
            (Some(first), _) if !is_covered(first) => Some(first),
            (_, Some(last)) if !is_covered(last) => Some(last),
            _ => None,
        };
    }

    /// The stream saw activity at `at`.
    pub(super) fn activity(&mut self, at: Timestamp) {
        self.last_activity_at = Some(self.last_activity_at.map_or(at, |last| last.max(at)));
        self.uncovered_activity_at.get_or_insert(at);
    }

    /// The subscription was confirmed at `at`: a top-up is owed.
    pub(super) fn subscribed(&mut self, at: Timestamp) {
        self.is_subscribed = true;
        self.unsubscribed_since = None;
        self.top_up_since.get_or_insert(at);
    }

    /// The subscription was lost at `at`.
    pub(super) fn unsubscribed(&mut self, at: Timestamp) {
        self.is_subscribed = false;
        self.unsubscribed_since.get_or_insert(at);
    }

    /// Events were lost at `at`: a top-up is owed.
    pub(super) fn events_lost(&mut self, at: Timestamp) {
        self.top_up_since.get_or_insert(at);
    }

    /// Whether the subscription is live.
    pub(super) const fn is_subscribed(&self) -> bool {
        self.is_subscribed
    }

    /// Since when the subscription is down (since `started_at` if it never came up), and
    /// whether the check is late by more than twice its cadence, at `now`.
    pub(super) fn lag(&self, started_at: Timestamp, now: Timestamp) -> (Option<Timestamp>, bool) {
        let unsubscribed_since =
            (!self.is_subscribed).then(|| self.unsubscribed_since.unwrap_or(started_at));
        let is_overdue = self
            .last_check_at
            .is_some_and(|last| later(last, self.cadence().saturating_mul(2)) < now);
        (unsubscribed_since, is_overdue)
    }

    fn cadence(&self) -> SignedDuration {
        if self.is_subscribed {
            SUBSCRIBED_CADENCE
        } else {
            UNSUBSCRIBED_CADENCE
        }
    }
}

/// `instant` plus `delay`, or the end of time.
fn later(instant: Timestamp, delay: SignedDuration) -> Timestamp {
    instant.checked_add(delay).unwrap_or(Timestamp::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn start() -> Timestamp {
        Timestamp::from_second(1_790_000_000).unwrap()
    }

    fn at(secs: i64) -> Timestamp {
        later(start(), SignedDuration::from_secs(secs))
    }

    /// The check due first.
    fn first_due(checks: &WalletChecks) -> (Timestamp, CheckReason) {
        checks.due(start()).into_iter().min().unwrap()
    }

    /// A wallet subscribed and checked at startup.
    fn checked_at_startup() -> WalletChecks {
        let mut checks = WalletChecks::default();
        checks.subscribed(at(0));
        checks.checked(at(0));
        checks
    }

    #[test]
    fn checks_a_bursting_wallet_with_one_listing() {
        let mut checks = checked_at_startup();

        for second in [100, 105, 110, 115, 120] {
            checks.activity(at(second));
        }

        assert_eq!(first_due(&checks), (at(150), CheckReason::Activity));
        checks.checked(at(150));
        assert_eq!(first_due(&checks), (at(1_050), CheckReason::Cadence));
    }

    #[test]
    fn checks_a_wallet_that_never_stops_two_minutes_after_its_first_activity() {
        let mut checks = checked_at_startup();

        for second in (100..=300).step_by(10) {
            checks.activity(at(second));
        }

        assert_eq!(first_due(&checks), (at(220), CheckReason::Activity));
    }

    #[test]
    fn checks_a_busy_wallet_at_most_once_a_minute() {
        let mut checks = checked_at_startup();
        checks.activity(at(10));
        checks.checked(at(40));

        checks.activity(at(45));

        assert_eq!(first_due(&checks), (at(100), CheckReason::Activity));
    }

    #[test]
    fn keeps_an_activity_a_too_early_check_could_not_cover() {
        let mut checks = WalletChecks::default();
        checks.subscribed(at(0));
        checks.activity(at(1));

        checks.checked(at(2));

        assert_eq!(first_due(&checks), (at(62), CheckReason::Activity));
    }

    #[test]
    fn checks_every_minute_while_unsubscribed() {
        let mut checks = checked_at_startup();

        checks.unsubscribed(at(1));

        assert_eq!(first_due(&checks), (at(60), CheckReason::Cadence));
    }

    #[test]
    fn holds_a_failing_check_back_longer_after_each_failure() {
        let mut checks = WalletChecks::default();
        checks.subscribed(at(0));

        assert_eq!(checks.failed(at(0)), (1, at(30)));
        assert_eq!(first_due(&checks), (at(30), CheckReason::TopUp));
        assert_eq!(checks.failed(at(30)), (2, at(90)));
        checks.checked(at(90));
        assert_eq!(checks.failed(at(100)), (1, at(130)));
    }

    #[test]
    fn tells_how_long_a_subscription_is_down_and_whether_a_check_is_late() {
        let mut checks = WalletChecks::default();
        assert_eq!(checks.lag(start(), at(5)), (Some(start()), false));
        checks.subscribed(at(1));
        checks.checked(at(1));
        assert_eq!(checks.lag(start(), at(1_801)), (None, false));
        assert_eq!(checks.lag(start(), at(1_802)), (None, true));

        checks.unsubscribed(at(1_900));

        assert_eq!(checks.lag(start(), at(1_950)).0, Some(at(1_900)));
    }
}
