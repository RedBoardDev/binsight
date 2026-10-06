//! How up to date a wallet is, from the worst state to the best, as a pure rule.
//!
//! - `Error`: a human must act: the provider refuses binsight's requests (the key, the plan, the
//!   credits), or transactions keep failing to be fetched after an hour of attempts.
//! - `Importing`: its history is not fully listed, or not fully fetched yet.
//! - `Lagging`: it may miss something for now: its subscription has been down for more than a
//!   minute, a check is late by more than twice its cadence, live work has waited for more than
//!   two minutes, or a credit limit stops every request.
//! - `Live`: none of the above.
//!
//! The rule also tells when a state could change with time alone (a tolerance running out, a
//! refusal ending), so the monitor can sleep until then instead of polling. This module decides;
//! the sync monitor gathers the facts.

use binsight_store::WalletBacklog;
use jiff::{SignedDuration, Timestamp};

/// How long a subscription may be down before the wallet lags.
const UNSUBSCRIBED_TOLERANCE: SignedDuration = SignedDuration::from_mins(1);

/// How long live work may wait past its due time before the wallet lags.
const LIVE_WORK_TOLERANCE: SignedDuration = SignedDuration::from_mins(2);

/// How often the state is decided again while a credit limit stops every request: the limit lifts
/// at a day or cycle boundary the monitor does not track.
const CREDIT_LIMIT_RECHECK: SignedDuration = SignedDuration::from_mins(5);

/// How up to date a wallet is, the worst first.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum SyncState {
    /// Something keeps failing; a human should look.
    Error,
    /// Its history is being imported.
    Importing,
    /// Behind the chain for now; it catches up by itself.
    Lagging,
    /// Up to date.
    Live,
}

/// What stops every request, if anything.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Stop {
    /// The provider refuses binsight's requests until this instant: a human must act.
    ProviderRefusal {
        /// When binsight tries again.
        until: Timestamp,
    },
    /// A credit limit is reached: it lifts by itself.
    CreditLimit,
}

/// What the sync state of one wallet is decided from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct SyncFacts {
    /// Whether every signature down to its first transaction is listed.
    pub(super) is_history_listed: bool,
    /// What keeps its registry behind.
    pub(super) backlog: WalletBacklog,
    /// What stops every request, if anything.
    pub(super) stop: Option<Stop>,
    /// Since when its subscription is down, if it is.
    pub(super) unsubscribed_since: Option<Timestamp>,
    /// After this instant its check is late by more than twice its cadence.
    pub(super) check_late_after: Option<Timestamp>,
}

/// The sync state `facts` describe at `now`.
pub(super) fn sync_state(facts: &SyncFacts, now: Timestamp) -> SyncState {
    if matches!(facts.stop, Some(Stop::ProviderRefusal { .. }))
        || facts.backlog.failed > 0
        || facts.backlog.unsupported_version > 0
    {
        return SyncState::Error;
    }
    if !facts.is_history_listed || facts.backlog.history_unfetched > 0 {
        return SyncState::Importing;
    }
    let is_lagging = facts.stop == Some(Stop::CreditLimit)
        || lag_deadlines(facts).any(|deadline| now > deadline);
    if is_lagging {
        SyncState::Lagging
    } else {
        SyncState::Live
    }
}

/// The first instant after `now` at which the state `facts` describe could change with nothing
/// else happening, if there is one.
pub(super) fn next_change(facts: &SyncFacts, now: Timestamp) -> Option<Timestamp> {
    let stop_ends = match facts.stop {
        Some(Stop::ProviderRefusal { until }) => Some(until),
        Some(Stop::CreditLimit) => now.checked_add(CREDIT_LIMIT_RECHECK).ok(),
        None => None,
    };
    lag_deadlines(facts)
        .chain(stop_ends)
        .filter(|instant| *instant > now)
        .min()
}

/// The instants after which the wallet lags: a tolerance past each fact that ages.
fn lag_deadlines(facts: &SyncFacts) -> impl Iterator<Item = Timestamp> {
    let after = |instant: Option<Timestamp>, tolerance: SignedDuration| {
        instant.and_then(|instant| instant.checked_add(tolerance).ok())
    };
    [
        facts.check_late_after,
        after(facts.unsubscribed_since, UNSUBSCRIBED_TOLERANCE),
        after(facts.backlog.oldest_live_due_at, LIVE_WORK_TOLERANCE),
    ]
    .into_iter()
    .flatten()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn now() -> Timestamp {
        Timestamp::from_second(1_790_000_000).unwrap()
    }

    fn ago(secs: i64) -> Timestamp {
        now().checked_sub(SignedDuration::from_secs(secs)).unwrap()
    }

    fn live() -> SyncFacts {
        SyncFacts {
            is_history_listed: true,
            backlog: WalletBacklog::default(),
            stop: None,
            unsubscribed_since: None,
            check_late_after: None,
        }
    }

    #[test]
    fn is_live_when_nothing_is_behind() {
        assert_eq!(sync_state(&live(), now()), SyncState::Live);
    }

    #[test]
    fn reports_an_error_before_anything_else() {
        let failing = SyncFacts {
            is_history_listed: false,
            backlog: WalletBacklog {
                failed: 1,
                ..WalletBacklog::default()
            },
            ..live()
        };
        let refused = SyncFacts {
            stop: Some(Stop::ProviderRefusal { until: ago(-60) }),
            ..live()
        };

        assert_eq!(sync_state(&failing, now()), SyncState::Error);
        assert_eq!(sync_state(&refused, now()), SyncState::Error);
    }

    #[test]
    fn never_reports_live_when_an_unsupported_transaction_is_parked() {
        let parked = SyncFacts {
            backlog: WalletBacklog {
                unsupported_version: 1,
                ..WalletBacklog::default()
            },
            ..live()
        };
        assert_eq!(sync_state(&parked, now()), SyncState::Error);
    }

    #[test]
    fn imports_until_the_history_is_listed_and_fetched() {
        let listing = SyncFacts {
            is_history_listed: false,
            ..live()
        };
        let fetching = SyncFacts {
            backlog: WalletBacklog {
                history_unfetched: 3,
                ..WalletBacklog::default()
            },
            ..live()
        };

        assert_eq!(sync_state(&listing, now()), SyncState::Importing);
        assert_eq!(sync_state(&fetching, now()), SyncState::Importing);
    }

    #[test]
    fn lags_once_the_subscription_is_down_for_more_than_a_minute() {
        let briefly = SyncFacts {
            unsubscribed_since: Some(ago(60)),
            ..live()
        };
        let long = SyncFacts {
            unsubscribed_since: Some(ago(61)),
            ..live()
        };

        assert_eq!(sync_state(&briefly, now()), SyncState::Live);
        assert_eq!(sync_state(&long, now()), SyncState::Lagging);
    }

    #[test]
    fn lags_when_live_work_waits_for_more_than_two_minutes() {
        let waiting = SyncFacts {
            backlog: WalletBacklog {
                oldest_live_due_at: Some(ago(121)),
                ..WalletBacklog::default()
            },
            ..live()
        };

        assert_eq!(sync_state(&waiting, now()), SyncState::Lagging);
    }

    #[test]
    fn lags_while_a_credit_limit_or_a_late_check_holds_it_back() {
        let stopped = SyncFacts {
            stop: Some(Stop::CreditLimit),
            ..live()
        };
        let late = SyncFacts {
            check_late_after: Some(ago(1)),
            ..live()
        };

        assert_eq!(sync_state(&stopped, now()), SyncState::Lagging);
        assert_eq!(sync_state(&late, now()), SyncState::Lagging);
    }

    #[test]
    fn needs_no_wake_up_when_nothing_can_age() {
        let checked = SyncFacts {
            check_late_after: Some(ago(-1_800)),
            ..live()
        };

        assert_eq!(next_change(&live(), now()), None);
        assert_eq!(next_change(&checked, now()), Some(ago(-1_800)));
    }

    #[test]
    fn wakes_when_the_first_tolerance_runs_out_or_a_refusal_ends() {
        let ageing = SyncFacts {
            unsubscribed_since: Some(ago(30)),
            backlog: WalletBacklog {
                oldest_live_due_at: Some(ago(100)),
                ..WalletBacklog::default()
            },
            check_late_after: Some(ago(-600)),
            ..live()
        };
        let refused = SyncFacts {
            stop: Some(Stop::ProviderRefusal { until: ago(-90) }),
            ..live()
        };

        assert_eq!(next_change(&ageing, now()), Some(ago(-20)));
        assert_eq!(next_change(&refused, now()), Some(ago(-90)));
    }

    #[test]
    fn ignores_the_tolerances_already_run_out() {
        let lagging = SyncFacts {
            unsubscribed_since: Some(ago(600)),
            ..live()
        };

        assert_eq!(sync_state(&lagging, now()), SyncState::Lagging);
        assert_eq!(next_change(&lagging, now()), None);
    }
}
