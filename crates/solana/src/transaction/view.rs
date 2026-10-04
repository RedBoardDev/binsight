//! What binsight knows about a transaction once it is read.
//!
//! A [`TransactionView`] holds everything the decoders and the ledger need, in checked domain
//! types, so nothing downstream reads the node's JSON again. A failed transaction is read whole:
//! its fee was charged, but its instructions changed nothing. This module only defines the view;
//! [`super::read`] builds it.

use jiff::Timestamp;

use super::{AccountKey, FeeBreakdown, InstructionNode, NativeBalance, TokenBalance, TxVersion};
use crate::{Address, Signature};

/// A transaction as binsight reads it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TransactionView {
    /// The first signature, which identifies the transaction.
    pub signature: Signature,
    /// The slot it landed in.
    pub slot: u64,
    /// The estimated time of its block; `None` when the node does not know it (never replaced
    /// by a made-up date).
    pub block_time: Option<Timestamp>,
    /// Its position in its block (the node's `transactionIndex`), when the node reports it: with
    /// the slot, it orders transactions exactly.
    pub transaction_index: Option<u32>,
    /// Its format.
    pub version: TxVersion,
    /// Whether it succeeded.
    pub outcome: TxOutcome,
    /// The account that paid the fee (the first signer).
    pub fee_payer: Address,
    /// The fee and its parts.
    pub fee: FeeBreakdown,
    /// Every account, static ones first, then the ones loaded from lookup tables.
    pub accounts: Vec<AccountKey>,
    /// Every instruction, top-level and inner, in execution order.
    pub instructions: Vec<InstructionNode>,
    /// The lamports of every account before and after, in account order.
    pub native_balances: Vec<NativeBalance>,
    /// The tokens of every token account before and after, in account order.
    pub token_balances: Vec<TokenBalance>,
}

/// Whether a transaction succeeded.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TxOutcome {
    /// Every instruction succeeded.
    Succeeded,
    /// An instruction failed: only the fee was charged.
    Failed {
        /// The node's `meta.err`, as compact JSON.
        error: String,
    },
}
