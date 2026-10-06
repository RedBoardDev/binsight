//! Which wallet's listing is repaired next, and when, as pure bookkeeping.
//!
//! Every wallet whose history is fully listed is repaired every six hours: its signatures are
//! listed again down to the last point a repair verified (`repair_pass`). The schedule is kept
//! in the database, so a binsight stopped for longer repairs at once when it starts. A wallet
//! never repaired is first repaired six hours after it was added (the import itself listed
//! everything just before), in full; a full repair asked for (by the owner or by the startup
//! check) is due at once. A failed repair holds its wallet back with the shared backoff. This
//! module decides; it does no I/O.

use std::collections::HashMap;

use binsight_solana::Address;
use binsight_store::{ListedTop, TrackedWallet, WalletCursor, WalletRepair};
use jiff::{SignedDuration, Timestamp};

use crate::ingestion::failure_backoff::retry_delay;

/// How often a wallet is repaired.
const REPAIR_CADENCE: SignedDuration = SignedDuration::from_hours(6);

/// The next repair to run.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum NextRepair {
    /// Repair this wallet now.
    Repair(RepairRange),
    /// No repair is due before this instant.
    WaitUntil(Timestamp),
    /// No wallet can be repaired.
    Nothing,
}

/// What one repair lists again.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct RepairRange {
    /// The wallet.
    pub(super) wallet: Address,
    /// Its cursor's newest signature when the repair starts: newer signatures are the top-up's.
    pub(super) ceiling: ListedTop,
    /// The point an earlier repair verified, which this one stops at; `None` to repair the
    /// whole history.
    pub(super) floor: Option<ListedTop>,
}

/// The repairs that failed, per wallet: how many in a row, and until when the wallet waits.
#[derive(Debug, Default)]
pub(super) struct RepairSchedule {
    held: HashMap<Address, (u32, Timestamp)>,
}

impl RepairSchedule {
    /// The repair due first among `wallets` at `now`, from where their repairs stand.
    pub(super) fn next(
        &self,
        wallets: &[TrackedWallet],
        repairs: &[WalletRepair],
        now: Timestamp,
    ) -> NextRepair {
        let due_first = wallets
            .iter()
            .filter_map(|wallet| {
                let WalletCursor::HistoryComplete { top: Some(ceiling) } = wallet.cursor else {
                    return None;
                };
                let repair = repairs
                    .iter()
                    .find(|repair| repair.wallet == wallet.address);
                let range = RepairRange {
                    wallet: wallet.address,
                    ceiling,
                    floor: repair.and_then(|repair| repair.verified),
                };
                Some((self.due_at(wallet, repair), range))
            })
            .min_by_key(|(due_at, range)| (*due_at, range.wallet));
        match due_first {
            None => NextRepair::Nothing,
            Some((due_at, _)) if due_at > now => NextRepair::WaitUntil(due_at),
            Some((_, range)) => NextRepair::Repair(range),
        }
    }

    /// A repair of `wallet` ended.
    pub(super) fn ended(&mut self, wallet: Address) {
        self.held.remove(&wallet);
    }

    /// A repair of `wallet` failed at `now`; returns how many in a row, and when it is tried
    /// again.
    pub(super) fn failed(&mut self, wallet: Address, now: Timestamp) -> (u32, Timestamp) {
        let (failures, _) = self.held.get(&wallet).copied().unwrap_or((0, now));
        let failures = failures.saturating_add(1);
        let retry_at = later(now, retry_delay(failures));
        self.held.insert(wallet, (failures, retry_at));
        (failures, retry_at)
    }

    /// When `wallet`'s next repair is due, given where its repair stands.
    fn due_at(&self, wallet: &TrackedWallet, repair: Option<&WalletRepair>) -> Timestamp {
        let scheduled = match repair {
            None => later(wallet.added_at, REPAIR_CADENCE),
            Some(WalletRepair {
                repaired_at: None, ..
            }) => Timestamp::MIN,
            Some(WalletRepair {
                repaired_at: Some(repaired_at),
                ..
            }) => later(*repaired_at, REPAIR_CADENCE),
        };
        let held_until = self.held.get(&wallet.address).map(|(_, until)| *until);
        held_until.map_or(scheduled, |until| scheduled.max(until))
    }
}

/// `instant` plus `delay`, or the end of time.
fn later(instant: Timestamp, delay: SignedDuration) -> Timestamp {
    instant.checked_add(delay).unwrap_or(Timestamp::MAX)
}

#[cfg(test)]
mod tests {
    use binsight_solana::Signature;

    use super::*;

    fn now() -> Timestamp {
        Timestamp::from_second(1_790_000_000).unwrap()
    }

    fn at(hours: i64) -> Timestamp {
        later(now(), SignedDuration::from_hours(hours))
    }

    fn top(seed: u8) -> ListedTop {
        ListedTop {
            signature: Signature::from_bytes([seed; 64]),
            slot: u64::from(seed) * 100,
        }
    }

    fn wallet(seed: u8, cursor: WalletCursor) -> TrackedWallet {
        TrackedWallet {
            address: Address::from_bytes([seed; 32]),
            added_at: now(),
            cursor,
        }
    }

    fn complete(seed: u8) -> TrackedWallet {
        wallet(
            seed,
            WalletCursor::HistoryComplete {
                top: Some(top(seed)),
            },
        )
    }

    fn repaired(seed: u8, verified: Option<ListedTop>, at: Option<Timestamp>) -> WalletRepair {
        WalletRepair {
            wallet: Address::from_bytes([seed; 32]),
            verified,
            repaired_at: at,
        }
    }

    #[test]
    fn first_repairs_a_new_wallet_in_full_six_hours_after_it_was_added() {
        let schedule = RepairSchedule::default();
        let wallets = [complete(1)];

        assert_eq!(
            schedule.next(&wallets, &[], at(1)),
            NextRepair::WaitUntil(at(6))
        );
        assert_eq!(
            schedule.next(&wallets, &[], at(6)),
            NextRepair::Repair(RepairRange {
                wallet: wallets[0].address,
                ceiling: top(1),
                floor: None,
            })
        );
    }

    #[test]
    fn repairs_down_to_the_verified_point_six_hours_after_the_last_repair() {
        let schedule = RepairSchedule::default();
        let repairs = [repaired(1, Some(top(9)), Some(at(10)))];

        let next = schedule.next(&[complete(1)], &repairs, at(16));

        assert!(matches!(next, NextRepair::Repair(range) if range.floor == Some(top(9))));
        assert_eq!(
            schedule.next(&[complete(1)], &repairs, at(15)),
            NextRepair::WaitUntil(at(16))
        );
    }

    #[test]
    fn repairs_at_once_and_in_full_when_a_full_repair_is_asked() {
        let schedule = RepairSchedule::default();
        let repairs = [repaired(1, None, None)];

        let next = schedule.next(&[complete(1)], &repairs, now());

        assert!(matches!(next, NextRepair::Repair(range) if range.floor.is_none()));
    }

    #[test]
    fn never_repairs_a_history_still_being_listed_or_without_any_transaction() {
        let schedule = RepairSchedule::default();
        let wallets = [
            wallet(1, WalletCursor::NotStarted),
            wallet(
                2,
                WalletCursor::ListingHistory {
                    top: top(2),
                    before: Signature::from_bytes([3; 64]),
                },
            ),
            wallet(4, WalletCursor::HistoryComplete { top: None }),
        ];

        assert_eq!(schedule.next(&wallets, &[], at(100)), NextRepair::Nothing);
    }

    #[test]
    fn holds_a_failing_wallet_back_until_its_retry_is_due() {
        let mut schedule = RepairSchedule::default();
        let wallets = [complete(1), complete(2)];
        let repairs = [repaired(1, None, None), repaired(2, None, Some(now()))];

        let (failures, retry_at) = schedule.failed(wallets[0].address, now());

        assert_eq!(failures, 1);
        assert_eq!(
            schedule.next(&wallets, &repairs, now()),
            NextRepair::WaitUntil(retry_at)
        );
        schedule.ended(wallets[0].address);
        assert!(matches!(
            schedule.next(&wallets, &repairs, now()),
            NextRepair::Repair(range) if range.wallet == wallets[0].address
        ));
    }
}
