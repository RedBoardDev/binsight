//! The cursor rules of a wallet's history listing, as pure functions.
//!
//! The history is listed from the newest signature down to the wallet's first transaction, one
//! page at a time. Three lessons of the old tracker shape these rules: a page moves the cursor
//! only once it is written (the store writes both together), a failed read is never taken for an
//! empty page (the chain client returns an error, so no rule here ever sees it), and the end of a
//! history is never taken on the word of a single answer. A node may return a short page without
//! an error (when it cannot read its long-term storage, or does not find the `before` signature),
//! and a history completed too early would never be listed again. So a page shorter than the
//! node's limit only ends the history once a second listing of the same page, made later,
//! confirms it (`history_end`). This module decides; it does no I/O.

use binsight_chain::{SIGNATURE_PAGE_LIMIT, SignatureInfo, SignaturesRequest};
use binsight_solana::Address;
use binsight_store::{ListedTop, WalletCursor};

use super::history_end::ListedEnd;

/// What a listed history page does to the cursor.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum HistoryStep {
    /// Write the page and move the cursor here.
    MoveTo(WalletCursor),
    /// Write the page, leave the cursor where it is, and list the same page again later: it may
    /// be the end of the history.
    ConfirmEnd(ListedEnd),
}

/// The next history page to list for `wallet`, or `None` once its history is complete.
pub(super) fn next_history_request(
    wallet: Address,
    cursor: &WalletCursor,
) -> Option<SignaturesRequest> {
    match *cursor {
        WalletCursor::NotStarted => Some(SignaturesRequest {
            address: wallet,
            before: None,
            until: None,
        }),
        WalletCursor::ListingHistory { before, .. } => Some(SignaturesRequest {
            address: wallet,
            before: Some(before),
            until: None,
        }),
        WalletCursor::HistoryComplete { .. } => None,
    }
}

/// What the history page `page` (newest first), listed for `request`, does to `cursor`, given
/// the short page an earlier listing of the same page returned, if any.
///
/// The first page sets the top; a full page leaves the history open below its last signature; a
/// shorter one, empty included, completes it only if it confirms `unconfirmed_end`.
pub(super) fn step_after_history_page(
    cursor: &WalletCursor,
    request: &SignaturesRequest,
    page: &[SignatureInfo],
    unconfirmed_end: Option<&ListedEnd>,
) -> HistoryStep {
    let top = match *cursor {
        WalletCursor::NotStarted => page.first().map(|newest| ListedTop {
            signature: newest.signature,
            slot: newest.slot,
        }),
        WalletCursor::ListingHistory { top, .. } => Some(top),
        WalletCursor::HistoryComplete { .. } => return HistoryStep::MoveTo(*cursor),
    };
    if let (Some(top), Some(oldest)) = (top, page.last())
        && page.len() >= SIGNATURE_PAGE_LIMIT
    {
        return HistoryStep::MoveTo(WalletCursor::ListingHistory {
            top,
            before: oldest.signature,
        });
    }
    let end = ListedEnd::of(request, page);
    if unconfirmed_end.is_some_and(|earlier| earlier.is_confirmed_by(&end)) {
        HistoryStep::MoveTo(WalletCursor::HistoryComplete { top })
    } else {
        HistoryStep::ConfirmEnd(end)
    }
}

#[cfg(test)]
mod tests {
    use binsight_solana::Signature;

    use super::*;

    const WALLET: Address = Address::from_bytes([1; 32]);

    fn entry(seed: u8, slot: u64) -> SignatureInfo {
        SignatureInfo {
            signature: Signature::from_bytes([seed; 64]),
            slot,
            block_time: None,
            is_failed: false,
        }
    }

    fn full_page(newest_slot: u64) -> Vec<SignatureInfo> {
        (0..SIGNATURE_PAGE_LIMIT)
            .map(|index| {
                let offset = u64::try_from(index).unwrap();
                entry(u8::try_from(index % 200).unwrap(), newest_slot - offset)
            })
            .collect()
    }

    fn top(seed: u8, slot: u64) -> ListedTop {
        ListedTop {
            signature: Signature::from_bytes([seed; 64]),
            slot,
        }
    }

    fn listing_below_seven() -> WalletCursor {
        WalletCursor::ListingHistory {
            top: top(1, 90),
            before: Signature::from_bytes([7; 64]),
        }
    }

    fn below_seven() -> SignaturesRequest {
        next_history_request(WALLET, &listing_below_seven()).unwrap()
    }

    fn first_page() -> SignaturesRequest {
        next_history_request(WALLET, &WalletCursor::NotStarted).unwrap()
    }

    /// The end an earlier listing of `request` found with `page`.
    fn unconfirmed(request: &SignaturesRequest, page: &[SignatureInfo]) -> ListedEnd {
        ListedEnd::of(request, page)
    }

    #[test]
    fn starts_the_history_from_the_newest_signature() {
        assert_eq!(first_page().before, None);
    }

    #[test]
    fn continues_the_history_below_the_last_listed_page() {
        assert_eq!(below_seven().before, Some(Signature::from_bytes([7; 64])));
    }

    #[test]
    fn lists_nothing_more_once_the_history_is_complete() {
        let cursor = WalletCursor::HistoryComplete { top: None };
        assert_eq!(next_history_request(WALLET, &cursor), None);
    }

    #[test]
    fn keeps_the_history_open_below_a_full_first_page() {
        let page = full_page(5_000);

        let step = step_after_history_page(&WalletCursor::NotStarted, &first_page(), &page, None);

        assert_eq!(
            step,
            HistoryStep::MoveTo(WalletCursor::ListingHistory {
                top: top(0, 5_000),
                before: page.last().unwrap().signature,
            })
        );
    }

    #[test]
    fn asks_for_a_confirmation_before_ending_the_history_on_a_short_page() {
        let page = [entry(8, 40)];

        let step = step_after_history_page(&listing_below_seven(), &below_seven(), &page, None);

        assert_eq!(
            step,
            HistoryStep::ConfirmEnd(unconfirmed(&below_seven(), &page))
        );
    }

    #[test]
    fn completes_the_history_when_a_second_listing_confirms_the_short_page() {
        let page = [entry(8, 40), entry(9, 30)];
        let earlier = unconfirmed(&below_seven(), &page);

        let step = step_after_history_page(
            &listing_below_seven(),
            &below_seven(),
            &page,
            Some(&earlier),
        );

        assert_eq!(
            step,
            HistoryStep::MoveTo(WalletCursor::HistoryComplete {
                top: Some(top(1, 90))
            })
        );
    }

    #[test]
    fn keeps_the_history_open_when_the_page_shrinks_on_the_second_listing() {
        let earlier = unconfirmed(&below_seven(), &[entry(8, 40), entry(9, 30)]);
        let shrunk = [entry(9, 30)];

        let step = step_after_history_page(
            &listing_below_seven(),
            &below_seven(),
            &shrunk,
            Some(&earlier),
        );

        assert_eq!(
            step,
            HistoryStep::ConfirmEnd(unconfirmed(&below_seven(), &shrunk))
        );
    }

    #[test]
    fn completes_a_first_page_that_gained_newer_signatures_meanwhile() {
        let earlier = unconfirmed(&first_page(), &[entry(8, 40), entry(9, 30)]);
        let later = [entry(3, 50), entry(8, 40), entry(9, 30)];

        let step = step_after_history_page(
            &WalletCursor::NotStarted,
            &first_page(),
            &later,
            Some(&earlier),
        );

        assert_eq!(
            step,
            HistoryStep::MoveTo(WalletCursor::HistoryComplete {
                top: Some(top(3, 50))
            })
        );
    }

    #[test]
    fn completes_the_history_of_a_wallet_without_transactions_once_confirmed() {
        let earlier = unconfirmed(&first_page(), &[]);

        let step = step_after_history_page(
            &WalletCursor::NotStarted,
            &first_page(),
            &[],
            Some(&earlier),
        );

        assert_eq!(
            step,
            HistoryStep::MoveTo(WalletCursor::HistoryComplete { top: None })
        );
    }

    #[test]
    fn completes_a_history_whose_last_full_page_is_followed_by_a_confirmed_empty_one() {
        let earlier = unconfirmed(&below_seven(), &[]);

        let step =
            step_after_history_page(&listing_below_seven(), &below_seven(), &[], Some(&earlier));

        assert_eq!(
            step,
            HistoryStep::MoveTo(WalletCursor::HistoryComplete {
                top: Some(top(1, 90))
            })
        );
    }
}
