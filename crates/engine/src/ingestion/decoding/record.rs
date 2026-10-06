//! Reads one immutable raw transaction and records what the DLMM decoder concludes about it.
//!
//! The verdict says whether the transaction holds DLMM activity the decoder reads, holds none,
//! or cannot be read (with the error), and how it executed on chain. The events themselves are
//! not kept: accounting reads the raw transaction through `position_activity`, which also
//! yields no activity for a failed transaction.

use binsight_dlmm::{DECODER_NAME, DECODER_VERSION};
use binsight_solana::Commitment;
use binsight_solana::transaction::{TransactionView, TxEncoding, read};
use binsight_store::{DecodeOutcome, DecodeRecord, RawTxRecord};
use jiff::Timestamp;

pub(super) fn decode(raw: &RawTxRecord, payload: &[u8], decoded_at: Timestamp) -> DecodeRecord {
    let mut record = unreadable(raw.signature, decoded_at, "transaction has not been read");
    let transaction = match read(payload) {
        Ok(transaction) => transaction,
        Err(error) => {
            record.outcome = failed(error);
            return record;
        }
    };
    if !matches_registry(raw, &transaction) {
        record.outcome = failed("transaction does not match its finalized base64 registry row");
        return record;
    }
    record.execution_outcome = Some(transaction.outcome.clone());
    record.outcome = decode_activity(&transaction).unwrap_or_else(failed);
    record
}

pub(super) fn unreadable(
    signature: binsight_solana::Signature,
    decoded_at: Timestamp,
    error: impl std::fmt::Display,
) -> DecodeRecord {
    DecodeRecord {
        signature,
        decoder: DECODER_NAME.to_owned(),
        decoder_version: DECODER_VERSION,
        execution_outcome: None,
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
