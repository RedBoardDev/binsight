//! Sample listed pages and a store tracking one wallet, for the tests of the ingestion
//! repositories. Only compiled for tests.

use binsight_core::credits::Priority;
use binsight_solana::transaction::{TxEncoding, TxVersion};
use binsight_solana::{Address, Commitment, Signature};
use jiff::{SignedDuration, Timestamp};

use super::{FetchedTx, ListedSignature, ListedTop, ListingPage, WalletCursor};
use crate::database::test_database::migrated_store;
use crate::store::Store;

/// The wallet the tests track.
pub(super) const WALLET: Address = Address::from_bytes([1; 32]);

/// The instant the tests list their pages at.
pub(super) fn listed_at() -> Timestamp {
    Timestamp::from_second(1_790_000_000).unwrap()
}

/// A successful signature made of `seed` bytes, alone in `slot`.
pub(super) fn listed(seed: u8, slot: u64) -> ListedSignature {
    ListedSignature {
        signature: Signature::from_bytes([seed; 64]),
        slot,
        block_time: Some(listed_at()),
        is_failed: false,
    }
}

/// A first history page of `signatures` for `wallet`, the first one becoming the top.
pub(super) fn history_page(wallet: Address, signatures: Vec<ListedSignature>) -> ListingPage {
    let cursor = match (signatures.first(), signatures.last()) {
        (Some(first), Some(last)) => WalletCursor::ListingHistory {
            top: ListedTop {
                signature: first.signature,
                slot: first.slot,
            },
            before: last.signature,
        },
        _ => WalletCursor::HistoryComplete { top: None },
    };
    ListingPage {
        wallet,
        signatures,
        previous_cursor: WalletCursor::NotStarted,
        cursor,
        fetch_priority: Priority::History,
        listed_at: listed_at(),
    }
}

/// The history page of `signatures` listed after `previous` was written.
pub(super) fn page_after(previous: &ListingPage, signatures: Vec<ListedSignature>) -> ListingPage {
    ListingPage {
        previous_cursor: previous.cursor,
        ..history_page(previous.wallet, signatures)
    }
}

/// A migrated store tracking [`WALLET`].
pub(super) async fn store_with_wallet() -> (tempfile::TempDir, Store) {
    let (folder, store) = migrated_store().await;
    store.wallets().add(WALLET, listed_at()).await.unwrap();
    (folder, store)
}

/// `seconds` after [`listed_at`].
pub(super) fn later(seconds: i64) -> Timestamp {
    listed_at()
        .checked_add(SignedDuration::from_secs(seconds))
        .unwrap()
}

/// The fetched transaction whose signature is made of `seed` bytes, with `payload`.
pub(super) fn fetched(seed: u8, payload: &[u8]) -> FetchedTx {
    FetchedTx {
        signature: Signature::from_bytes([seed; 64]),
        slot: 20,
        block_time: Some(listed_at()),
        tx_version: TxVersion::V1,
        commitment: Commitment::Finalized,
        encoding: TxEncoding::Base64,
        payload: payload.to_vec(),
        fetched_at: listed_at(),
    }
}
