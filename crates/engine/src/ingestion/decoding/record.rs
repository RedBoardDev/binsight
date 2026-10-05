//! Reads one immutable raw transaction and stores events with their instruction provenance.
//!
//! Persisted events describe emissions, including those of failed transactions. Accounting
//! reads the raw transaction through `position_activity`, which yields no activity on failure.

use binsight_dlmm::{DECODER_NAME, DECODER_VERSION, DlmmEvent, LocatedEvent};
use binsight_solana::Commitment;
use binsight_solana::transaction::{TransactionView, TxEncoding, read};
use binsight_store::{DecodeOutcome, DecodeRecord, DecodedEvent, RawTxRecord};
use jiff::Timestamp;
use serde::Serialize;

#[derive(Serialize)]
struct EventLocation {
    top: u16,
    inner: Option<u16>,
}

#[derive(Serialize)]
struct StoredEvent {
    at: EventLocation,
    event: DlmmEvent,
}

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
    if !has_program {
        return Ok(DecodeOutcome::NotApplicable);
    }
    events
        .iter()
        .map(stored_event)
        .collect::<Result<Vec<_>, _>>()
        .map(DecodeOutcome::Decoded)
}

fn stored_event(located: &LocatedEvent) -> Result<DecodedEvent, String> {
    let event = StoredEvent {
        at: EventLocation {
            top: located.at.top,
            inner: located.at.inner,
        },
        event: located.event,
    };
    Ok(DecodedEvent {
        kind: format!("{DECODER_NAME}.{}", located.event.kind()),
        payload_json: serde_json::to_string(&event).map_err(|error| error.to_string())?,
    })
}

fn failed(error: impl std::fmt::Display) -> DecodeOutcome {
    DecodeOutcome::Failed {
        error: error.to_string(),
    }
}

#[cfg(test)]
mod tests;
