//! Reads one immutable raw transaction and records what the DLMM decoder concludes about it, and
//! what it left in the tracked wallets' token accounts.
//!
//! The verdict says whether the transaction holds DLMM activity the decoder reads, holds none,
//! or cannot be read (with the error), how it executed on chain and where it sits in its block.
//! The events themselves are not kept: accounting reads the raw transaction through
//! `position_activity`, which also yields no activity for a failed transaction. The token
//! balances are read from the same view (`token_balances`).

use std::collections::HashSet;

use binsight_dlmm::{DECODER_NAME, DECODER_VERSION};
use binsight_solana::transaction::{READER_VERSION, TransactionView, TxEncoding, read};
use binsight_solana::{Address, Commitment};
use binsight_store::{DecodeOutcome, DecodeRecord, RawTxRecord, TokenAccountBalance};
use jiff::Timestamp;

use super::token_balances::tracked_token_balances;

/// What reading one registry row concludes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct Decoding {
    /// The decoder's verdict.
    pub(super) record: DecodeRecord,
    /// What the transaction left in the token accounts the tracked wallets own, before or after
    /// it; nothing when it could not be read.
    pub(super) token_accounts: Vec<TokenAccountBalance>,
}

impl Decoding {
    /// A verdict on a transaction that could not be read: no balance is known.
    pub(super) fn verdict_only(record: DecodeRecord) -> Self {
        Self {
            record,
            token_accounts: Vec::new(),
        }
    }
}

/// What the decoder concludes about the registry row `raw`, its payload included (a damaged
/// payload is a failed result like any other), for the tracked `wallets`.
pub(super) fn decode_stored(
    raw: &RawTxRecord,
    decoded_at: Timestamp,
    wallets: &HashSet<Address>,
) -> Decoding {
    match raw.uncompressed_payload() {
        Ok(payload) => decode(raw, &payload, decoded_at, wallets),
        Err(error) => Decoding::verdict_only(unreadable(raw.signature, decoded_at, error)),
    }
}

/// What the decoder concludes about `payload`, the node's answer stored as `raw`, for the
/// tracked `wallets`.
pub(super) fn decode(
    raw: &RawTxRecord,
    payload: &[u8],
    decoded_at: Timestamp,
    wallets: &HashSet<Address>,
) -> Decoding {
    let mut record = unreadable(raw.signature, decoded_at, "transaction has not been read");
    let transaction = match read(payload) {
        Ok(transaction) => transaction,
        Err(error) => {
            record.outcome = failed(error);
            return Decoding::verdict_only(record);
        }
    };
    if !matches_registry(raw, &transaction) {
        record.outcome = failed("transaction does not match its finalized base64 registry row");
        return Decoding::verdict_only(record);
    }
    record.execution_outcome = Some(transaction.outcome.clone());
    record.transaction_index = transaction.transaction_index;
    record.outcome = decode_activity(&transaction).unwrap_or_else(failed);
    Decoding {
        record,
        token_accounts: tracked_token_balances(&transaction, wallets),
    }
}

/// A failed result for `signature`, whose execution stays unknown.
pub(super) fn unreadable(
    signature: binsight_solana::Signature,
    decoded_at: Timestamp,
    error: impl std::fmt::Display,
) -> DecodeRecord {
    DecodeRecord {
        signature,
        decoder: DECODER_NAME.to_owned(),
        decoder_version: DECODER_VERSION,
        reader_version: READER_VERSION,
        execution_outcome: None,
        transaction_index: None,
        outcome: failed(error),
        decoded_at,
    }
}

fn matches_registry(raw: &RawTxRecord, transaction: &TransactionView) -> bool {
    raw.signature == transaction.signature
        && raw.slot == transaction.slot
        && raw.tx_version == transaction.version
        && raw.commitment == Commitment::Finalized
        && raw.encoding == TxEncoding::Base64
}

fn decode_activity(transaction: &TransactionView) -> Result<DecodeOutcome, String> {
    let events = binsight_dlmm::decode_events(transaction).map_err(|error| error.to_string())?;
    binsight_dlmm::position_activity(transaction, &events).map_err(|error| error.to_string())?;
    let has_program = transaction
        .instructions
        .iter()
        .any(|instruction| instruction.program == binsight_dlmm::program::PROGRAM_ID);
    Ok(if has_program {
        DecodeOutcome::Decoded
    } else {
        DecodeOutcome::NotApplicable
    })
}

fn failed(error: impl std::fmt::Display) -> DecodeOutcome {
    DecodeOutcome::Failed {
        error: error.to_string(),
    }
}

#[cfg(test)]
mod tests;
