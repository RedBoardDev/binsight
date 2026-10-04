//! The vocabulary of the fetch queue: a task, how a failed attempt sets it back, and a fetched
//! transaction.
//!
//! Each listed signature has one fetch task, shared by every wallet that lists it. The engine
//! decides what a failed attempt means (try again when, or park); these types carry its decision
//! to the store. This module also gives each state its text in the `tx_fetch` table.

use binsight_core::credits::Priority;
use binsight_solana::Commitment;
use binsight_solana::Signature;
use binsight_solana::transaction::{TxEncoding, TxVersion};
use jiff::Timestamp;

/// A transaction waiting to be fetched.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FetchTask {
    /// Its signature.
    pub signature: Signature,
    /// The slot it was listed at.
    pub slot: u64,
    /// How urgent fetching it is.
    pub priority: Priority,
    /// How many attempts were already made.
    pub attempts: u32,
}

/// Why a task waits for its next attempt.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RetryState {
    /// The last attempt failed for a reason that should pass (a timeout, a server error...).
    Pending,
    /// The node answered that it does not have the transaction (yet).
    EmptyRetry,
    /// The attempts ran out; the task is still tried again, rarely, and never dropped.
    Failed,
}

impl RetryState {
    pub(super) const fn as_sql(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::EmptyRetry => "empty_retry",
            Self::Failed => "failed",
        }
    }
}

/// What a failed attempt does to its task.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FetchSetback {
    /// The task is tried again at `at`.
    RetryAt {
        /// Why it waits.
        state: RetryState,
        /// When it is due again.
        at: Timestamp,
    },
    /// The node cannot return this transaction's version; the task waits until binsight reads
    /// newer versions.
    UnsupportedVersion {
        /// The newest transaction version binsight could read when the task was parked.
        max_supported_version: u8,
    },
}

/// A failed attempt to fetch a transaction, and its consequence.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FetchFailure {
    /// The transaction.
    pub signature: Signature,
    /// What happens to the task.
    pub setback: FetchSetback,
    /// How many attempts the task has made, this one included.
    pub attempts: u32,
    /// What went wrong, for whoever investigates, if it was an error.
    pub error: Option<String>,
    /// When the attempt ended.
    pub updated_at: Timestamp,
}

/// A transaction as the node returned it, ready for the registry.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FetchedTx {
    /// Its signature.
    pub signature: Signature,
    /// The slot it landed in.
    pub slot: u64,
    /// When its block was produced, if the node said so.
    pub block_time: Option<Timestamp>,
    /// Its format version.
    pub tx_version: TxVersion,
    /// The commitment it was fetched at.
    pub commitment: Commitment,
    /// The encoding it was requested in.
    pub encoding: TxEncoding,
    /// The node's answer, uncompressed; the store compresses it.
    pub payload: Vec<u8>,
    /// When it was fetched.
    pub fetched_at: Timestamp,
}
