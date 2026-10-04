//! Which wallet's history page to list next, and when, as pure bookkeeping.
//!
//! Each wallet has its own retry delay: a page that cannot be listed or written is tried again
//! after 30 seconds, then twice as long after each failure in a row, up to an hour, and the
//! delay resets once a page of that wallet is written. A short page that may end a history waits
//! five minutes for its confirmation, the second listing `history_cursor` asks for. The worker always
//! lists the wallet that is due first, so a wallet whose page keeps failing neither blocks the
//! others nor spends credits every few seconds. All of this lives in memory only: a restart tries
//! every wallet again at once, which costs one page each. This module decides; it does no I/O.

use std::collections::HashMap;

use binsight_chain::SignaturesRequest;
use binsight_solana::Address;
use binsight_store::TrackedWallet;
use jiff::{SignedDuration, Timestamp};

use super::history_cursor::next_history_request;
use super::history_end::ListedEnd;

/// The delay before trying a wallet's page again after its first failure in a row.
const FIRST_RETRY_DELAY_SECS: i64 = 30;

/// The longest delay between two attempts at a wallet's page.
const LONGEST_RETRY_DELAY_SECS: i64 = 3_600;

/// How long a short page waits before it is listed again to confirm the end of a history: long
/// enough for a node that could not read its long-term storage to recover.
const END_CONFIRMATION_DELAY_SECS: i64 = 300;

/// What the listing worker does next.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum NextListing<'wallets> {
    /// List this page of this wallet now.
    List {
        /// The wallet.
        wallet: &'wallets TrackedWallet,
        /// The page.
        request: SignaturesRequest,
    },
    /// No page is due before this instant.
    WaitUntil(Timestamp),
    /// Every history is complete.
    Nothing,
}

/// When each wallet's next page is due.
#[derive(Debug, Default)]
pub(super) struct ListingSchedule {
    wallets: HashMap<Address, Waiting>,
}

/// Why a wallet's next page is not due at once.
#[derive(Debug, Clone, Default)]
struct Waiting {
    /// When the page is due.
    due_at: Option<Timestamp>,
    /// How many attempts in a row failed.
    failures_in_a_row: u32,
    /// The short page that may end the history, until a second listing confirms it.
    unconfirmed_end: Option<ListedEnd>,
}

impl ListingSchedule {
    /// The page to list next among `wallets` at `now`: the wallet due first, the first in the
    /// list among those due at the same instant.
    pub(super) fn next<'wallets>(
        &self,
        wallets: &'wallets [TrackedWallet],
        now: Timestamp,
    ) -> NextListing<'wallets> {
        let due_first = wallets
            .iter()
            .filter_map(|wallet| {
                let request = next_history_request(wallet.address, &wallet.cursor)?;
                Some((self.due_at(wallet.address, now), wallet, request))
            })
            .min_by_key(|(due_at, _, _)| *due_at);
        match due_first {
            None => NextListing::Nothing,
            Some((due_at, _, _)) if due_at > now => NextListing::WaitUntil(due_at),
            Some((_, wallet, request)) => NextListing::List { wallet, request },
        }
    }

    /// The short page an earlier listing of `wallet` returned, waiting for its confirmation.
    pub(super) fn unconfirmed_end(&self, wallet: Address) -> Option<&ListedEnd> {
        self.wallets
            .get(&wallet)
            .and_then(|waiting| waiting.unconfirmed_end.as_ref())
    }

    /// Records that a page of `wallet` was written at `now`: its next page is due at once, or,
    /// if it may be the end of the history, after the confirmation delay.
    pub(super) fn record_page(
        &mut self,
        wallet: Address,
        unconfirmed_end: Option<ListedEnd>,
        now: Timestamp,
    ) {
        self.wallets.remove(&wallet);
        if let Some(end) = unconfirmed_end {
            let due_at = now
                .checked_add(SignedDuration::from_secs(END_CONFIRMATION_DELAY_SECS))
                .unwrap_or(Timestamp::MAX);
            let waiting = Waiting {
                due_at: Some(due_at),
                failures_in_a_row: 0,
                unconfirmed_end: Some(end),
            };
            self.wallets.insert(wallet, waiting);
        }
    }

    /// Records that a page of `wallet` failed at `now`, and returns how many times in a row it
    /// has, and when it is tried again.
    pub(super) fn record_failure(&mut self, wallet: Address, now: Timestamp) -> (u32, Timestamp) {
        let waiting = self.wallets.entry(wallet).or_default();
        waiting.failures_in_a_row = waiting.failures_in_a_row.saturating_add(1);
        let retry_at = now
            .checked_add(retry_delay(waiting.failures_in_a_row))
            .unwrap_or(Timestamp::MAX);
        waiting.due_at = Some(retry_at);
        (waiting.failures_in_a_row, retry_at)
    }

    /// When `wallet`'s next page is due: now, unless it waits for a retry or a confirmation.
    fn due_at(&self, wallet: Address, now: Timestamp) -> Timestamp {
        self.wallets
            .get(&wallet)
            .and_then(|waiting| waiting.due_at)
            .map_or(now, |due_at| due_at.max(now))
    }
}

/// The delay after `failures_in_a_row` failures: 30 s doubled for each failure after the first,
/// at most an hour.
fn retry_delay(failures_in_a_row: u32) -> SignedDuration {
    let doublings = failures_in_a_row.saturating_sub(1);
    let secs = 2_i64
        .checked_pow(doublings)
        .and_then(|factor| factor.checked_mul(FIRST_RETRY_DELAY_SECS))
        .map_or(LONGEST_RETRY_DELAY_SECS, |secs| {
            secs.min(LONGEST_RETRY_DELAY_SECS)
        });
    SignedDuration::from_secs(secs)
}

#[cfg(test)]
mod tests {
    use binsight_store::WalletCursor;

    use super::*;

    fn now() -> Timestamp {
        Timestamp::from_second(1_790_000_000).unwrap()
    }

    fn later(secs: i64) -> Timestamp {
        now().checked_add(SignedDuration::from_secs(secs)).unwrap()
    }

    fn wallet(seed: u8, cursor: WalletCursor) -> TrackedWallet {
        TrackedWallet {
            address: Address::from_bytes([seed; 32]),
            added_at: now(),
            cursor,
        }
    }

    /// The end an empty first page of `wallet` leaves to confirm.
    fn empty_page_end(wallet: &TrackedWallet) -> ListedEnd {
        ListedEnd::of(
            &next_history_request(wallet.address, &wallet.cursor).unwrap(),
            &[],
        )
    }

    fn listed_wallet(next: NextListing<'_>) -> Address {
        match next {
            NextListing::List { wallet, .. } => wallet.address,
            other => panic!("nothing to list: {other:?}"),
        }
    }

    #[test]
    fn lists_the_first_wallet_whose_history_is_not_complete() {
        let wallets = [
            wallet(1, WalletCursor::HistoryComplete { top: None }),
            wallet(2, WalletCursor::NotStarted),
            wallet(3, WalletCursor::NotStarted),
        ];

        let next = ListingSchedule::default().next(&wallets, now());

        assert_eq!(listed_wallet(next), wallets[1].address);
    }

    #[test]
    fn lists_the_other_wallets_while_a_failed_one_waits() {
        let wallets = [
            wallet(1, WalletCursor::NotStarted),
            wallet(2, WalletCursor::NotStarted),
        ];
        let mut schedule = ListingSchedule::default();

        schedule.record_failure(wallets[0].address, now());

        assert_eq!(
            listed_wallet(schedule.next(&wallets, now())),
            wallets[1].address
        );
    }

    #[test]
    fn waits_for_the_wallet_due_first_when_none_is_due() {
        let wallets = [wallet(1, WalletCursor::NotStarted)];
        let mut schedule = ListingSchedule::default();

        let (failures, retry_at) = schedule.record_failure(wallets[0].address, now());

        assert_eq!((failures, retry_at), (1, later(30)));
        assert_eq!(
            schedule.next(&wallets, later(10)),
            NextListing::WaitUntil(later(30))
        );
        assert!(matches!(
            schedule.next(&wallets, later(30)),
            NextListing::List { .. }
        ));
    }

    #[test]
    fn doubles_the_delay_after_each_failure_in_a_row_up_to_an_hour() {
        let address = Address::from_bytes([1; 32]);
        let mut schedule = ListingSchedule::default();

        let delays: Vec<i64> = (0..10)
            .map(|_| schedule.record_failure(address, now()).1.as_second() - now().as_second())
            .collect();

        assert_eq!(
            delays,
            [30, 60, 120, 240, 480, 960, 1_920, 3_600, 3_600, 3_600]
        );
    }

    #[test]
    fn starts_again_from_the_first_delay_once_a_page_is_written() {
        let address = Address::from_bytes([1; 32]);
        let mut schedule = ListingSchedule::default();
        schedule.record_failure(address, now());
        schedule.record_failure(address, now());

        schedule.record_page(address, None, now());

        assert_eq!(schedule.record_failure(address, now()), (1, later(30)));
    }

    #[test]
    fn lists_a_short_page_again_five_minutes_later_to_confirm_the_end() {
        let wallets = [wallet(1, WalletCursor::NotStarted)];
        let mut schedule = ListingSchedule::default();
        let end = empty_page_end(&wallets[0]);

        schedule.record_page(wallets[0].address, Some(end.clone()), now());

        assert_eq!(
            schedule.next(&wallets, now()),
            NextListing::WaitUntil(later(300))
        );
        assert_eq!(schedule.unconfirmed_end(wallets[0].address), Some(&end));
    }

    #[test]
    fn keeps_the_end_to_confirm_when_the_confirmation_fails() {
        let wallets = [wallet(1, WalletCursor::NotStarted)];
        let mut schedule = ListingSchedule::default();
        let end = empty_page_end(&wallets[0]);
        schedule.record_page(wallets[0].address, Some(end.clone()), now());

        schedule.record_failure(wallets[0].address, later(300));

        assert_eq!(schedule.unconfirmed_end(wallets[0].address), Some(&end));
        assert_eq!(
            schedule.next(&wallets, later(300)),
            NextListing::WaitUntil(later(330))
        );
    }

    #[test]
    fn has_nothing_to_list_once_every_history_is_complete() {
        let wallets = [wallet(1, WalletCursor::HistoryComplete { top: None })];

        assert_eq!(
            ListingSchedule::default().next(&wallets, now()),
            NextListing::Nothing
        );
    }
}
