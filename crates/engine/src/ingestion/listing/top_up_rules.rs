//! What one page of a top-up holds, and where the cursor's top goes, as pure rules.
//!
//! A top-up lists a wallet's signatures newer than its top, newest first, page after page. Two
//! rules from the old tracker shape it. The top only rises once the top-up has reached it: a
//! page shorter than the node's limit (the node stopped at the top) or a signature in a slot
//! older than the top's (the top's own signature was not found, and the listing went past it);
//! a top-up stopped halfway leaves the top where it was, so the next one lists the gap again.
//! And a top-up never wanders below the top: signatures of older slots are dropped, so a missing
//! top cannot turn it into a listing of the whole history. This module decides; it does no I/O.

use binsight_chain::{SIGNATURE_PAGE_LIMIT, SignatureInfo};
use binsight_store::{ListedTop, WalletCursor};

/// What a top-up page holds.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(in crate::ingestion) struct TopUpPage {
    /// The page's signatures newer than the top, newest first.
    pub(in crate::ingestion) newer: Vec<SignatureInfo>,
    /// Whether the page reached the top: the top-up ends with it.
    pub(in crate::ingestion) reached_top: bool,
}

/// Reads `page`, listed for a top-up above `top` (`None` for a wallet without any signature).
pub(in crate::ingestion) fn read_top_up_page(
    top: Option<ListedTop>,
    page: &[SignatureInfo],
) -> TopUpPage {
    let newer: Vec<SignatureInfo> = page
        .iter()
        .take_while(|entry| top.is_none_or(|top| entry.slot >= top.slot))
        .copied()
        .collect();
    let went_past_the_top = newer.len() < page.len();
    TopUpPage {
        reached_top: went_past_the_top || page.len() < SIGNATURE_PAGE_LIMIT,
        newer,
    }
}

/// `cursor` with its top raised to `newest`, the newest signature a top-up found.
pub(super) fn raise_top(cursor: WalletCursor, newest: ListedTop) -> WalletCursor {
    match cursor {
        WalletCursor::NotStarted => WalletCursor::NotStarted,
        WalletCursor::ListingHistory { before, .. } => WalletCursor::ListingHistory {
            top: newest,
            before,
        },
        WalletCursor::HistoryComplete { .. } => WalletCursor::HistoryComplete { top: Some(newest) },
    }
}

#[cfg(test)]
mod tests {
    use binsight_solana::Signature;

    use super::*;

    fn entry(seed: u8, slot: u64) -> SignatureInfo {
        SignatureInfo {
            signature: Signature::from_bytes([seed; 64]),
            slot,
            block_time: None,
            is_failed: false,
        }
    }

    fn top() -> ListedTop {
        ListedTop {
            signature: Signature::from_bytes([1; 64]),
            slot: 100,
        }
    }

    fn full_page(newest_slot: u64) -> Vec<SignatureInfo> {
        (0..SIGNATURE_PAGE_LIMIT)
            .map(|index| entry(7, newest_slot - u64::try_from(index).unwrap() / 10))
            .collect()
    }

    #[test]
    fn reaches_the_top_on_a_short_page() {
        let page = [entry(3, 120), entry(2, 100)];

        let read = read_top_up_page(Some(top()), &page);

        assert_eq!(read.newer, page);
        assert!(read.reached_top);
    }

    #[test]
    fn keeps_going_after_a_full_page_above_the_top() {
        let page = full_page(1_000);

        let read = read_top_up_page(Some(top()), &page);

        assert_eq!(read.newer.len(), SIGNATURE_PAGE_LIMIT);
        assert!(!read.reached_top);
    }

    #[test]
    fn stops_a_top_up_at_the_slot_of_the_known_top_when_its_signature_is_missing() {
        let page = full_page(150);

        let read = read_top_up_page(Some(top()), &page);

        assert!(read.reached_top);
        assert_eq!(read.newer.len(), 510);
        assert!(read.newer.iter().all(|entry| entry.slot >= 100));
    }

    #[test]
    fn raises_the_top_and_keeps_the_history_where_it_was() {
        let newest = ListedTop {
            signature: Signature::from_bytes([3; 64]),
            slot: 120,
        };
        let before = Signature::from_bytes([5; 64]);
        let listing = WalletCursor::ListingHistory { top: top(), before };

        assert_eq!(
            raise_top(listing, newest),
            WalletCursor::ListingHistory {
                top: newest,
                before
            }
        );
        assert_eq!(
            raise_top(WalletCursor::HistoryComplete { top: None }, newest),
            WalletCursor::HistoryComplete { top: Some(newest) }
        );
    }
}
