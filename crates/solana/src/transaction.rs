//! Reading a Solana transaction from the `getTransaction` answer of a node.
//!
//! [`read`] takes the `result` of `getTransaction` requested with the `base64` encoding and
//! `maxSupportedTransactionVersion: 1`, reads the signed bytes (legacy, version 0 or version 1)
//! and the meta, and returns a [`TransactionView`]. It is pure and exact: no network, no
//! `jsonParsed` rendering, no floating point. Deciding what a transaction means for a wallet is
//! the job of the ledger.

mod accounts;
mod balances;
mod encoding;
mod error;
mod fee;
mod instructions;
mod rpc_response;
mod version;
mod view;
mod wire;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use binsight_core::units::Lamports;
use jiff::Timestamp;

pub use accounts::{AccountKey, AccountSource};
pub use balances::{NativeBalance, TokenBalance};
pub use encoding::TxEncoding;
pub use error::TransactionReadError;
pub use fee::{FeeBreakdown, LAMPORTS_PER_SIGNATURE};
pub use instructions::{InstructionData, InstructionNode, InstructionPosition};
pub use version::{MAX_SUPPORTED_TX_VERSION, TxVersion, UnsupportedTxVersion};
pub use view::{TransactionView, TxOutcome};

use crate::Address;
use crate::error::MalformedBytes;
use accounts::LoadedAddresses;
use balances::TokenBalanceLists;
use rpc_response::{RpcLoadedAddresses, RpcTransaction, RpcVersion};

/// The encoding name of a base64 transaction in the answer.
const BASE64_ENCODING: &str = "base64";

/// Reads the `result` of a `getTransaction` call (base64 encoding) into a [`TransactionView`].
///
/// # Errors
///
/// Returns a [`TransactionReadError`] when the JSON, the transaction bytes or the meta are
/// malformed or disagree with each other, or when the transaction uses a version binsight cannot
/// read.
pub fn read(json: &[u8]) -> Result<TransactionView, TransactionReadError> {
    let response: RpcTransaction =
        serde_json::from_slice(json).map_err(TransactionReadError::Json)?;
    let meta = response
        .meta
        .ok_or(TransactionReadError::MissingField { field: "meta" })?;
    let wire = wire::parse(&decode_base64(&response.transaction)?)?;
    let version = wire.format.version();
    check_declared_version(response.version, version)?;
    let loaded = loaded_addresses(meta.loaded_addresses, version)?;
    let accounts = accounts::resolve(&wire, loaded)?;
    let inner = meta
        .inner_instructions
        .ok_or(missing("innerInstructions"))?;
    let instructions = instructions::in_execution_order(&wire.instructions, &inner, &accounts)?;
    let fee = fee::breakdown(
        Lamports(meta.fee),
        &wire.format,
        &instructions,
        wire.header.required_signatures,
    )?;
    let pre_tokens = meta.pre_token_balances.ok_or(missing("preTokenBalances"))?;
    let post_tokens = meta
        .post_token_balances
        .ok_or(missing("postTokenBalances"))?;
    let first_signer = || MalformedBytes::UnexpectedEnd {
        what: "the first signature",
        offset: 0,
    };
    Ok(TransactionView {
        signature: *wire.signatures.first().ok_or_else(first_signer)?,
        slot: response.slot,
        block_time: response.block_time.map(timestamp).transpose()?,
        transaction_index: response.transaction_index,
        version,
        outcome: outcome(meta.err),
        fee_payer: accounts.first().ok_or_else(first_signer)?.address,
        fee,
        native_balances: balances::native(&accounts, &meta.pre_balances, &meta.post_balances)?,
        token_balances: balances::tokens(
            &accounts,
            &TokenBalanceLists {
                pre: &pre_tokens,
                post: &post_tokens,
                slot: response.slot,
            },
        )?,
        instructions,
        accounts,
    })
}

/// The outcome the meta's `err` reports.
fn outcome(error: Option<serde_json::Value>) -> TxOutcome {
    match error {
        None => TxOutcome::Succeeded,
        Some(error) => TxOutcome::Failed {
            error: error.to_string(),
        },
    }
}

fn missing(field: &'static str) -> TransactionReadError {
    TransactionReadError::MissingField { field }
}

fn decode_base64(transaction: &(String, String)) -> Result<Vec<u8>, TransactionReadError> {
    let (data, encoding) = transaction;
    if encoding != BASE64_ENCODING {
        return Err(TransactionReadError::UnsupportedEncoding {
            encoding: encoding.clone(),
        });
    }
    STANDARD.decode(data).map_err(TransactionReadError::Base64)
}

/// Checks the `version` field of the answer against the version of the bytes.
fn check_declared_version(
    declared: Option<RpcVersion>,
    read: TxVersion,
) -> Result<(), TransactionReadError> {
    let declared = match declared {
        None => return Ok(()),
        Some(RpcVersion::Number(number)) => TxVersion::try_from(number)?,
        Some(RpcVersion::Name(name)) if name == "legacy" => TxVersion::Legacy,
        Some(RpcVersion::Name(name)) => {
            return Err(TransactionReadError::UnknownVersionName { name });
        }
    };
    if declared == read {
        Ok(())
    } else {
        Err(TransactionReadError::VersionMismatch { declared, read })
    }
}

/// The addresses the lookup tables loaded; a version 0 answer must list them.
fn loaded_addresses(
    loaded: Option<RpcLoadedAddresses>,
    version: TxVersion,
) -> Result<LoadedAddresses, TransactionReadError> {
    let Some(loaded) = loaded else {
        return match version {
            TxVersion::V0 => Err(missing("loadedAddresses")),
            TxVersion::Legacy | TxVersion::V1 => Ok(LoadedAddresses::default()),
        };
    };
    let parse_all = |texts: Vec<String>| -> Result<Vec<Address>, TransactionReadError> {
        texts
            .iter()
            .map(|text| parse_address(text, "loadedAddresses"))
            .collect()
    };
    Ok(LoadedAddresses {
        writable: parse_all(loaded.writable)?,
        readonly: parse_all(loaded.readonly)?,
    })
}

fn timestamp(seconds: i64) -> Result<Timestamp, TransactionReadError> {
    Timestamp::from_second(seconds).map_err(|_| TransactionReadError::InvalidBlockTime { seconds })
}

/// Parses a base58 address of the answer, naming its field on failure.
fn parse_address(text: &str, field: &'static str) -> Result<Address, TransactionReadError> {
    text.parse()
        .map_err(|source| TransactionReadError::InvalidAddress { field, source })
}
