//! The rank of each listed signature among the wallet's signatures of the same slot.
//!
//! A node lists signatures newest first. The rank in the listing (0 for the newest of a slot)
//! orders the signatures of a slot until their transactions are fetched; a fetched transaction
//! carries its exact index in its block, which is the canonical order. A slot cut between two
//! pages keeps counting where the previous page stopped. This module is pure.

use binsight_chain::SignatureInfo;
use binsight_store::ListedSignature;

/// Where the previous page ended: the slot of its last signature and that signature's rank.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct PageBoundary {
    /// The slot of the previous page's last (oldest) signature.
    pub(super) slot: u64,
    /// Its rank in that slot.
    pub(super) slot_order: u32,
}

/// The signatures of `page` (newest first) with their rank in their slot, continuing from
/// `boundary` when the page starts in the slot the previous page ended in.
pub(super) fn rank_in_slots(
    page: &[SignatureInfo],
    boundary: Option<PageBoundary>,
) -> Vec<ListedSignature> {
    let mut previous = boundary;
    page.iter()
        .map(|entry| {
            let slot_order = match previous {
                Some(before) if before.slot == entry.slot => before.slot_order.saturating_add(1),
                _ => 0,
            };
            previous = Some(PageBoundary {
                slot: entry.slot,
                slot_order,
            });
            ListedSignature {
                signature: entry.signature,
                slot: entry.slot,
                slot_order: Some(slot_order),
                block_time: entry.block_time,
                is_failed: entry.is_failed,
            }
        })
        .collect()
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
            is_failed: seed == 3,
        }
    }

    fn ranks(listed: &[ListedSignature]) -> Vec<(u64, u32)> {
        listed
            .iter()
            .map(|signature| (signature.slot, signature.slot_order.unwrap()))
            .collect()
    }

    #[test]
    fn ranks_the_newest_signature_of_each_slot_first() {
        let page = [entry(1, 30), entry(2, 30), entry(3, 30), entry(4, 20)];

        let listed = rank_in_slots(&page, None);

        assert_eq!(ranks(&listed), vec![(30, 0), (30, 1), (30, 2), (20, 0)]);
        assert!(listed[2].is_failed);
    }

    #[test]
    fn keeps_counting_a_slot_cut_between_two_pages() {
        let boundary = PageBoundary {
            slot: 30,
            slot_order: 1,
        };

        let listed = rank_in_slots(&[entry(5, 30), entry(6, 29)], Some(boundary));

        assert_eq!(ranks(&listed), vec![(30, 2), (29, 0)]);
    }

    #[test]
    fn starts_again_from_zero_when_the_page_starts_a_new_slot() {
        let boundary = PageBoundary {
            slot: 31,
            slot_order: 4,
        };

        let listed = rank_in_slots(&[entry(5, 30)], Some(boundary));

        assert_eq!(ranks(&listed), vec![(30, 0)]);
    }
}
