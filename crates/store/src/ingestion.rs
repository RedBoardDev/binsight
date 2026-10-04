//! Ingestion bookkeeping: the tracked wallets, how far each one's signatures are listed, and the
//! queue of transactions to fetch.
//!
//! Listing and fetching are kept apart. A listed page is written in one transaction with its
//! fetch tasks and the cursor move, so a cursor never passes a signature that was not written;
//! a fetch completes in one transaction with its `raw_tx` row, so "fetched" always means "in the
//! registry". This module stores what the engine decided; it decides nothing.

mod cursor;
mod detected;
mod fetch_counts;
mod fetch_queue;
mod fetch_results;
mod fetch_task;
mod listing_page;
mod signatures;
#[cfg(test)]
mod test_pages;
mod wallets;

pub use cursor::{ListedTop, WalletCursor};
pub use detected::DetectedSignature;
pub use fetch_counts::FetchCounts;
pub use fetch_queue::FetchQueueRepo;
pub use fetch_task::{FetchFailure, FetchSetback, FetchTask, FetchedTx, RetryState};
pub use listing_page::ListingPage;
pub use signatures::{ListedSignature, SignaturesRepo};
pub use wallets::{TrackedWallet, WalletsRepo};
