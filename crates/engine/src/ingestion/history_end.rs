//! A short history page that may be the end of a history, and what confirms it.
//!
//! A node may return a page shorter than its limit without an error: when it cannot read its
//! long-term storage, it returns what it found; a `before` signature it does not know gives an
//! empty page. Ending a history on such an answer would lose every older transaction for good.
//! So the short page is kept, and the same page is listed again later: the end is confirmed when
//! the second answer ends at the same signature and still holds every signature of the first.
//! Newer signatures on a first page are fine: the wallet kept trading meanwhile. This module is
//! pure.

use std::collections::HashSet;

use binsight_chain::{SignatureInfo, SignaturesRequest};
use binsight_solana::Signature;

/// A short page that may be the end of a history, kept until a second listing confirms it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct ListedEnd {
    /// The page's `before`.
    before: Option<Signature>,
    /// Its signatures, newest first.
    signatures: Vec<Signature>,
}

impl ListedEnd {
    pub(super) fn of(request: &SignaturesRequest, page: &[SignatureInfo]) -> Self {
        Self {
            before: request.before,
            signatures: page.iter().map(|entry| entry.signature).collect(),
        }
    }

    /// Whether `later`, a listing made after this one, confirms it: the same page, ending at the
    /// same signature, and still holding every signature this one held. Newer signatures on a
    /// first page are fine: the wallet kept trading meanwhile.
    pub(super) fn is_confirmed_by(&self, later: &Self) -> bool {
        let found_again: HashSet<&Signature> = later.signatures.iter().collect();
        self.before == later.before
            && self.signatures.last() == later.signatures.last()
            && self
                .signatures
                .iter()
                .all(|signature| found_again.contains(signature))
    }
}

#[cfg(test)]
mod tests {
    use binsight_solana::Address;

    use super::*;

    fn entry(seed: u8) -> SignatureInfo {
        SignatureInfo {
            signature: Signature::from_bytes([seed; 64]),
            slot: u64::from(seed),
            block_time: None,
            is_failed: false,
        }
    }

    fn end(before: Option<u8>, seeds: &[u8]) -> ListedEnd {
        let request = SignaturesRequest {
            address: Address::from_bytes([1; 32]),
            before: before.map(|seed| Signature::from_bytes([seed; 64])),
        };
        let page: Vec<SignatureInfo> = seeds.iter().map(|seed| entry(*seed)).collect();
        ListedEnd::of(&request, &page)
    }

    #[test]
    fn is_confirmed_by_the_same_answer() {
        assert!(end(Some(9), &[8, 7]).is_confirmed_by(&end(Some(9), &[8, 7])));
        assert!(end(None, &[]).is_confirmed_by(&end(None, &[])));
    }

    #[test]
    fn is_confirmed_by_a_first_page_that_gained_newer_signatures() {
        assert!(end(None, &[8, 7]).is_confirmed_by(&end(None, &[9, 8, 7])));
    }

    #[test]
    fn is_not_confirmed_when_a_signature_disappeared() {
        assert!(!end(Some(9), &[8, 7, 6]).is_confirmed_by(&end(Some(9), &[8, 6])));
    }

    #[test]
    fn is_not_confirmed_when_the_second_answer_goes_further_back() {
        assert!(!end(Some(9), &[8]).is_confirmed_by(&end(Some(9), &[8, 7])));
        assert!(!end(Some(9), &[]).is_confirmed_by(&end(Some(9), &[8])));
    }

    #[test]
    fn is_not_confirmed_by_another_page() {
        assert!(!end(Some(9), &[8]).is_confirmed_by(&end(None, &[8])));
    }
}
