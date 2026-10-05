//! One unbooked wallet transaction and the proof used to order it, without inventing an index.

use binsight_dlmm::activity::TxActivity;
use binsight_solana::Address;
use binsight_solana::transaction::TransactionView;

/// The origin of a transaction's position within its slot.
///
/// These spaces deliberately do not implement `Ord`: an ordinal cannot be compared with
/// a canonical index. An adapter must choose one space uniformly for the whole slot.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TransactionOrderProof {
    /// The original block index, which must match `TransactionView::transaction_index`.
    Canonical {
        /// The transaction's index in its block.
        index: u32,
    },
    /// A wallet-local listing rank from one consistent metadata snapshot, newest first.
    WalletOrdinal {
        /// Zero is the newest listed transaction of this wallet in the slot.
        rank: u32,
    },
}

/// A source kept with its original activity until transaction-local ownership is resolved.
///
/// The adapter verifies raw identity, slot, version and finalized payload provenance before
/// constructing this value. Sources are replayed oldest first; block time never sorts them.
/// Booking comes afterwards, with the ownership returned by [`super::PositionLifetimes`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PositionTransaction {
    /// The wallet whose ownership is being replayed.
    pub wallet: Address,
    /// The parsed original transaction, including execution outcome and optional block time.
    pub transaction: TransactionView,
    /// Activity recomputed from that same transaction's decoded events, without filtering rows.
    pub activity: TxActivity,
    /// The chosen ordering proof; absence remains a diagnostic rather than an index of zero.
    pub order: Option<TransactionOrderProof>,
}
