//! The JSON a node returns for `getTransaction` with the `base64` encoding, as private structs.
//!
//! Only the fields binsight reads are declared; serde skips the others. In particular the
//! floating-point `uiAmount` of token balances is never declared, so it is never parsed: amounts
//! are read from the exact integer string `amount`. This module only mirrors the JSON; turning it
//! into checked domain values happens in the modules that use it.

use serde::Deserialize;
use serde_json::Value;

/// The `result` of `getTransaction`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RpcTransaction {
    /// The slot the transaction landed in.
    pub(super) slot: u64,
    /// The estimated production time of the block, in seconds since the Unix epoch.
    pub(super) block_time: Option<i64>,
    /// The position of the transaction in its block, when the node reports it.
    #[serde(default)]
    pub(super) transaction_index: Option<u32>,
    /// `"legacy"`, or the version number; absent when the request did not ask for versions.
    #[serde(default)]
    pub(super) version: Option<RpcVersion>,
    /// The encoded transaction and its encoding: `["<base64>", "base64"]`.
    pub(super) transaction: (String, String),
    /// The execution status and balances; `null` when the node did not record it.
    pub(super) meta: Option<RpcMeta>,
}

/// The `version` field: a name for legacy transactions, a number for versioned ones.
#[derive(Debug, Deserialize)]
#[serde(untagged)]
pub(super) enum RpcVersion {
    /// A versioned transaction.
    Number(u8),
    /// `"legacy"`.
    Name(String),
}

/// The `meta` of a transaction.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RpcMeta {
    /// `null` when the transaction succeeded, otherwise the error.
    pub(super) err: Option<Value>,
    /// The total fee charged, in lamports.
    pub(super) fee: u64,
    /// The lamports of every account before the transaction, in account order.
    pub(super) pre_balances: Vec<u64>,
    /// The lamports of every account after the transaction, in account order.
    pub(super) post_balances: Vec<u64>,
    /// The instructions invoked by each top-level instruction.
    pub(super) inner_instructions: Option<Vec<RpcInnerInstructions>>,
    /// The token accounts before the transaction.
    pub(super) pre_token_balances: Option<Vec<RpcTokenBalance>>,
    /// The token accounts after the transaction.
    pub(super) post_token_balances: Option<Vec<RpcTokenBalance>>,
    /// The accounts loaded from lookup tables (version 0 only).
    #[serde(default)]
    pub(super) loaded_addresses: Option<RpcLoadedAddresses>,
}

/// The inner instructions of one top-level instruction.
#[derive(Debug, Deserialize)]
pub(super) struct RpcInnerInstructions {
    /// The position of the top-level instruction.
    pub(super) index: u8,
    /// Its inner instructions, in execution order.
    pub(super) instructions: Vec<RpcCompiledInstruction>,
}

/// An inner instruction: indexes into the account list and base58 data.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RpcCompiledInstruction {
    /// The index of the program account.
    pub(super) program_id_index: u8,
    /// The indexes of its accounts.
    pub(super) accounts: Vec<u8>,
    /// Its data, in base58.
    pub(super) data: String,
    /// Its depth in the call stack (1 is top level); absent from old transactions.
    #[serde(default)]
    pub(super) stack_height: Option<u8>,
}

/// One token account, before or after the transaction.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RpcTokenBalance {
    /// The index of the token account in the account list.
    pub(super) account_index: u8,
    /// The mint, in base58.
    pub(super) mint: String,
    /// The owner of the token account, in base58; absent from old transactions.
    #[serde(default)]
    pub(super) owner: Option<String>,
    /// The token program that owns the account, in base58; absent from old transactions.
    #[serde(default)]
    pub(super) program_id: Option<String>,
    /// The amount.
    pub(super) ui_token_amount: RpcTokenAmount,
}

/// The exact parts of `uiTokenAmount`: the raw amount as a decimal string and the decimals.
#[derive(Debug, Deserialize)]
pub(super) struct RpcTokenAmount {
    /// The raw amount, as a decimal integer string.
    pub(super) amount: String,
    /// The decimals of the mint.
    pub(super) decimals: u8,
}

/// The accounts a version 0 transaction loaded from its lookup tables, in base58.
#[derive(Debug, Deserialize)]
pub(super) struct RpcLoadedAddresses {
    /// Loaded as writable, in lookup order.
    pub(super) writable: Vec<String>,
    /// Loaded as read-only, in lookup order.
    pub(super) readonly: Vec<String>,
}
