//! When each wallet's newest signatures are listed again, as pure bookkeeping.
//!
//! The stream gives latency, the listing gives truth: every wallet whose history has started is
//! listed down to its newest known signature on a schedule, so nothing the stream missed stays
//! missed. A check is due for a top-up (after a confirmed subscription, at startup, after lost
//! events), for activity, or on the cadence (`wallet_checks`); this schedule keeps every
//! wallet's checks and picks the one due first. Any listing that starts from the newest
//! signature counts as a check, a history page included. This module decides; it does no I/O
//! and reads no clock.

use std::collections::HashMap;

use binsight_core::credits::Priority;
use binsight_solana::Address;
use binsight_store::{TrackedWallet, WalletCursor};
use jiff::Timestamp;

use super::wallet_checks::{CheckReason, WalletChecks};

/// The next check to make.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(in crate::ingestion) enum NextCheck {
    /// Check this wallet now.
    Check {
        /// The wallet.
        wallet: Address,
        /// Why.
        reason: CheckReason,
    },
    /// Nothing is due before this instant.
    WaitUntil(Timestamp),
    /// No wallet can be checked yet.
    Nothing,
}

/// Every wallet's checks.
#[derive(Debug)]
pub(in crate::ingestion) struct CheckSchedule {
    started_at: Timestamp,
    wallets: HashMap<Address, WalletChecks>,
}

impl CheckSchedule {
    /// A schedule for an engine started at `started_at`.
    pub(in crate::ingestion) fn new(started_at: Timestamp) -> Self {
        Self {
            started_at,
            wallets: HashMap::new(),
        }
    }

    /// The check due first among `wallets` at `now`, of `least_urgent` or a more urgent class;
    /// a top-up first among checks due together.
    pub(in crate::ingestion) fn next(
        &self,
        wallets: &[TrackedWallet],
        least_urgent: Priority,
        now: Timestamp,
    ) -> NextCheck {
        let due_first = wallets
            .iter()
            .filter(|wallet| wallet.cursor != WalletCursor::NotStarted)
            .flat_map(|wallet| {
                let checks = self
                    .wallets
                    .get(&wallet.address)
                    .copied()
                    .unwrap_or_default();
                let due = checks.due(self.started_at);
                due.into_iter()
                    .map(move |(due_at, reason)| (due_at, reason, wallet.address))
            })
            .filter(|(_, reason, _)| reason.priority() <= least_urgent)
            .min_by_key(|(due_at, reason, _)| (*due_at, *reason));
        match due_first {
            None => NextCheck::Nothing,
            Some((due_at, _, _)) if due_at > now => NextCheck::WaitUntil(due_at),
            Some((_, reason, wallet)) => NextCheck::Check { wallet, reason },
        }
    }

    /// A check of `wallet` failed at `now`; returns how many in a row, and when it is tried
    /// again (`failure_backoff`).
    pub(in crate::ingestion) fn failed(
        &mut self,
        wallet: Address,
        now: Timestamp,
    ) -> (u32, Timestamp) {
        self.wallets.entry(wallet).or_default().failed(now)
    }

    /// A listing of `wallet` from its newest signature started at `started_at` and was written.
    pub(in crate::ingestion) fn checked(&mut self, wallet: Address, started_at: Timestamp) {
        self.wallets.entry(wallet).or_default().checked(started_at);
    }

    /// The stream saw `wallet` active at `at`.
    pub(in crate::ingestion) fn activity(&mut self, wallet: Address, at: Timestamp) {
        self.wallets.entry(wallet).or_default().activity(at);
    }

    /// The stream confirmed `wallet`'s subscription at `at`: a top-up is owed.
    pub(in crate::ingestion) fn subscribed(&mut self, wallet: Address, at: Timestamp) {
        self.wallets.entry(wallet).or_default().subscribed(at);
    }

    /// `wallet` lost its subscription (refused).
    pub(in crate::ingestion) fn unsubscribed(&mut self, wallet: Address) {
        self.wallets.entry(wallet).or_default().unsubscribed();
    }

    /// The stream went down: no wallet is subscribed.
    pub(in crate::ingestion) fn stream_down(&mut self) {
        for checks in self.wallets.values_mut() {
            checks.unsubscribed();
        }
    }

    /// The stream dropped events at `at`: every wallet owes a top-up (one never checked owes
    /// its first one already).
    pub(in crate::ingestion) fn events_lost(&mut self, at: Timestamp) {
        for checks in self.wallets.values_mut() {
            checks.events_lost(at);
        }
    }

    /// Whether `wallet`'s subscription is live.
    pub(in crate::ingestion) fn is_subscribed(&self, wallet: Address) -> bool {
        self.wallets
            .get(&wallet)
            .is_some_and(WalletChecks::is_subscribed)
    }
}

#[cfg(test)]
mod tests {
    use binsight_solana::Signature;
    use binsight_store::ListedTop;

    use super::*;

    const WALLET: Address = Address::from_bytes([1; 32]);

    fn start() -> Timestamp {
        Timestamp::from_second(1_790_000_000).unwrap()
    }

    fn at(secs: i64) -> Timestamp {
        start()
            .checked_add(jiff::SignedDuration::from_secs(secs))
            .unwrap()
    }

    fn listed_wallet(cursor: WalletCursor) -> [TrackedWallet; 1] {
        [TrackedWallet {
            address: WALLET,
            added_at: start(),
            cursor,
        }]
    }

    fn complete() -> [TrackedWallet; 1] {
        let top = ListedTop {
            signature: Signature::from_bytes([9; 64]),
            slot: 90,
        };
        listed_wallet(WalletCursor::HistoryComplete { top: Some(top) })
    }

    fn check(reason: CheckReason) -> NextCheck {
        NextCheck::Check {
            wallet: WALLET,
            reason,
        }
    }

    #[test]
    fn tops_a_wallet_up_once_its_subscription_is_confirmed() {
        let mut schedule = CheckSchedule::new(start());

        schedule.subscribed(WALLET, at(2));

        assert_eq!(
            schedule.next(&complete(), Priority::Valuation, at(2)),
            check(CheckReason::TopUp)
        );
        schedule.checked(WALLET, at(2));
        assert_eq!(
            schedule.next(&complete(), Priority::Valuation, at(2)),
            NextCheck::WaitUntil(at(902))
        );
    }

    #[test]
    fn tops_a_wallet_up_after_startup_even_if_the_stream_never_confirms_it() {
        let schedule = CheckSchedule::new(start());

        assert_eq!(
            schedule.next(&complete(), Priority::Valuation, at(0)),
            NextCheck::WaitUntil(at(10))
        );
        assert_eq!(
            schedule.next(&complete(), Priority::Valuation, at(10)),
            check(CheckReason::TopUp)
        );
    }

    #[test]
    fn checks_nothing_before_the_history_listing_starts() {
        let mut schedule = CheckSchedule::new(start());
        schedule.subscribed(WALLET, at(1));

        let wallets = listed_wallet(WalletCursor::NotStarted);

        assert_eq!(
            schedule.next(&wallets, Priority::Valuation, at(60)),
            NextCheck::Nothing
        );
    }

    #[test]
    fn checks_every_minute_while_the_stream_is_down() {
        let mut schedule = CheckSchedule::new(start());
        schedule.subscribed(WALLET, at(0));
        schedule.checked(WALLET, at(0));

        schedule.stream_down();

        assert_eq!(
            schedule.next(&complete(), Priority::Valuation, at(1)),
            NextCheck::WaitUntil(at(60))
        );
    }

    #[test]
    fn tops_every_wallet_up_after_lost_events() {
        let mut schedule = CheckSchedule::new(start());
        schedule.subscribed(WALLET, at(0));
        schedule.checked(WALLET, at(0));

        schedule.events_lost(at(30));

        assert_eq!(
            schedule.next(&complete(), Priority::Valuation, at(30)),
            check(CheckReason::TopUp)
        );
        assert!(schedule.is_subscribed(WALLET));
    }
}
