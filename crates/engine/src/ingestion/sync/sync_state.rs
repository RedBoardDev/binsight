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
//! This module decides; the sync monitor gathers the facts.

use binsight_store::WalletBacklog;
use jiff::{SignedDuration, Timestamp};

/// How long a subscription may be down before the wallet lags.
const UNSUBSCRIBED_TOLERANCE: SignedDuration = SignedDuration::from_mins(1);

/// How long live work may wait past its due time before the wallet lags.
const LIVE_WORK_TOLERANCE: SignedDuration = SignedDuration::from_mins(2);

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
    /// The provider refuses binsight's requests: a human must act.
    ProviderRefusal,
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
    /// Whether its check is late by more than twice its cadence.
    pub(super) is_check_overdue: bool,
}

/// The sync state `facts` describe at `now`.
pub(super) fn sync_state(facts: &SyncFacts, now: Timestamp) -> SyncState {
    if facts.stop == Some(Stop::ProviderRefusal)
        || facts.backlog.failed > 0
        || facts.backlog.unsupported_version > 0
    {
        return SyncState::Error;
    }
    if !facts.is_history_listed || facts.backlog.history_unfetched > 0 {
        return SyncState::Importing;
    }
    let is_older_than = |instant: Option<Timestamp>, tolerance: SignedDuration| {
        instant.is_some_and(|instant| {
            instant
                .checked_add(tolerance)
                .is_ok_and(|deadline| now > deadline)
        })
    };
    let is_lagging = facts.stop == Some(Stop::CreditLimit)
        || facts.is_check_overdue
        || is_older_than(facts.unsubscribed_since, UNSUBSCRIBED_TOLERANCE)
        || is_older_than(facts.backlog.oldest_live_due_at, LIVE_WORK_TOLERANCE);
    if is_lagging {
        SyncState::Lagging
    } else {
        SyncState::Live
    }
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
            is_check_overdue: false,
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
            stop: Some(Stop::ProviderRefusal),
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
            is_check_overdue: true,
            ..live()
        };

        assert_eq!(sync_state(&stopped, now()), SyncState::Lagging);
        assert_eq!(sync_state(&late, now()), SyncState::Lagging);
    }
}
