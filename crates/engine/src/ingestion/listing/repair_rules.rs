//! What one page of a repair holds, as pure rules.
//!
//! A repair page is read like a top-up page (`top_up_rules`): down to a known point, the point
//! the last repair verified, or the wallet's first transaction for a full repair, and never below
//! that point's slot, so a point the node does not find cannot turn the repair into a listing of
//! the whole history. Of the page's signatures, only those no newer than the ceiling (the
//! cursor's top when the repair started) are compared with the rows; newer ones are the top-up's.
//! The newest compared signature that is at least an hour old can become the next verified point:
//! a node that indexed a transaction late has had an hour to catch up, and the next repair lists
//! that hour again. A full repair's cost is planned from how many signatures the wallet lists.
//! This module decides; it does no I/O.

use binsight_chain::{BilledMethod, RpcMethod, SIGNATURE_PAGE_LIMIT, SignatureInfo};
use binsight_core::credits::Credits;
use binsight_store::ListedTop;
use jiff::{SignedDuration, Timestamp};

use super::repair_schedule::RepairRange;
use super::top_up_rules::read_top_up_page;

/// How old a signature must be when a repair starts to become the next verified point.
const SETTLE_DELAY: SignedDuration = SignedDuration::from_hours(1);

/// What a full repair is planned to cost, before any gap it finds is fetched.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RepairEstimate {
    /// The listing requests it sends: one per full page of the wallet's listed signatures, and
    /// the last, shorter one. More if the chain holds signatures the wallet does not list yet.
    pub listing_requests: u64,
    /// What those requests cost.
    pub credits: Credits,
    /// What fetching each gap it finds costs on top.
    pub credits_per_gap: Credits,
}

/// The plan of a full repair of a wallet that lists `listed` signatures.
pub fn estimate_full_repair(listed: u64) -> RepairEstimate {
    let page = u64::try_from(SIGNATURE_PAGE_LIMIT)
        .unwrap_or(u64::MAX)
        .max(1);
    let listing_requests = (listed / page).saturating_add(1);
    let per_listing = BilledMethod::Rpc(RpcMethod::GetSignaturesForAddress).credits();
    RepairEstimate {
        listing_requests,
        credits: Credits(listing_requests.saturating_mul(per_listing.0)),
        credits_per_gap: BilledMethod::Rpc(RpcMethod::GetTransaction).credits(),
    }
}

/// What a repair page holds.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct RepairRead {
    /// The page's signatures between the floor and the ceiling, newest first.
    pub(super) in_range: Vec<SignatureInfo>,
    /// Whether the page reached the floor: the repair ends with it.
    pub(super) reached_floor: bool,
}

impl RepairRead {
    /// The newest signature of the page produced at or before `settled_at`, if one was.
    pub(super) fn newest_settled(&self, settled_at: Timestamp) -> Option<ListedTop> {
        self.in_range
            .iter()
            .find(|entry| entry.block_time.is_some_and(|at| at <= settled_at))
            .map(|entry| ListedTop {
                signature: entry.signature,
                slot: entry.slot,
            })
    }
}

/// Reads `page`, listed for the repair of `range`.
pub(super) fn read_repair_page(range: &RepairRange, page: &[SignatureInfo]) -> RepairRead {
    let read = read_top_up_page(range.floor, page);
    RepairRead {
        in_range: read
            .newer
            .into_iter()
            .filter(|entry| entry.slot <= range.ceiling.slot)
            .collect(),
        reached_floor: read.reached_top,
    }
}

/// The instant a signature must be produced at or before to be settled, for a repair started
/// at `started_at`.
pub(super) fn settled_before(started_at: Timestamp) -> Timestamp {
    started_at
        .checked_sub(SETTLE_DELAY)
        .unwrap_or(Timestamp::MIN)
}

#[cfg(test)]
mod tests {
    use binsight_chain::SIGNATURE_PAGE_LIMIT;
    use binsight_solana::{Address, Signature};

    use super::*;

    fn now() -> Timestamp {
        Timestamp::from_second(1_790_000_000).unwrap()
    }

    fn entry(seed: u8, slot: u64, minutes_ago: i64) -> SignatureInfo {
        SignatureInfo {
            signature: Signature::from_bytes([seed; 64]),
            slot,
            block_time: now()
                .checked_sub(SignedDuration::from_mins(minutes_ago))
                .ok(),
            is_failed: false,
        }
    }

    fn point(seed: u8, slot: u64) -> ListedTop {
        ListedTop {
            signature: Signature::from_bytes([seed; 64]),
            slot,
        }
    }

    fn range(floor: Option<ListedTop>) -> RepairRange {
        RepairRange {
            wallet: Address::from_bytes([1; 32]),
            ceiling: point(9, 900),
            floor,
        }
    }

    #[test]
    fn plans_one_listing_per_full_page_and_one_for_the_last_shorter_page() {
        let plans: Vec<u64> = [0, 999, 1_000, 2_500]
            .into_iter()
            .map(|listed| estimate_full_repair(listed).listing_requests)
            .collect();

        assert_eq!(plans, [1, 1, 2, 3]);
        assert_eq!(estimate_full_repair(2_500).credits, Credits(3));
        assert_eq!(estimate_full_repair(2_500).credits_per_gap, Credits(1));
    }

    #[test]
    fn compares_only_the_signatures_no_newer_than_the_top_when_the_repair_started() {
        let page = [entry(10, 950, 1), entry(9, 900, 2), entry(8, 800, 3)];

        let read = read_repair_page(&range(None), &page);

        let slots: Vec<u64> = read.in_range.iter().map(|entry| entry.slot).collect();
        assert_eq!(slots, [900, 800]);
        assert!(read.reached_floor);
    }

    #[test]
    fn keeps_going_after_a_full_page_and_stops_at_the_slot_of_the_verified_point() {
        let full: Vec<SignatureInfo> = (0..SIGNATURE_PAGE_LIMIT)
            .map(|index| entry(7, 900 - u64::try_from(index).unwrap() / 2, 10))
            .collect();

        let above = read_repair_page(&range(Some(point(1, 100))), &full);
        let reaching = read_repair_page(&range(Some(point(1, 600))), &full);

        assert!(!above.reached_floor);
        assert!(reaching.reached_floor);
        assert!(reaching.in_range.iter().all(|entry| entry.slot >= 600));
    }

    #[test]
    fn takes_the_newest_signature_older_than_an_hour_as_the_next_verified_point() {
        let page = [entry(9, 900, 30), entry(8, 800, 61), entry(7, 700, 120)];
        let read = read_repair_page(&range(None), &page);

        let settled = read.newest_settled(settled_before(now()));

        assert_eq!(settled, Some(point(8, 800)));
        let recent = read_repair_page(&range(None), &page[..1]);
        assert_eq!(recent.newest_settled(settled_before(now())), None);
    }
}
