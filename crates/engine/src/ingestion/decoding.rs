//! Decodes the registry at startup and after a fetch commits, without polling or network calls.
//!
//! A signature cursor bounds each traversal; it never orders financial activity. New writes
//! wake a fresh traversal, so a signature before the previous cursor is not lost.

mod record;

use std::time::Duration;

use binsight_dlmm::{DECODER_NAME, DECODER_VERSION};
use binsight_solana::Signature;
use binsight_store::{DecodeScan, StoreError};
use tokio_util::sync::CancellationToken;
use tracing::error;

use super::Ingestion;

const DECODE_BATCH_SIZE: u16 = 500;
const WRITE_RETRY_DELAY: Duration = Duration::from_secs(30);

#[derive(Debug, thiserror::Error)]
enum DecodeRunError {
    #[error("could not read or write the decoding registry")]
    Store(#[from] StoreError),
    #[error("the decoding task stopped unexpectedly")]
    Task(#[from] tokio::task::JoinError),
}

pub(super) async fn run_decoder(ingestion: &Ingestion, shutdown: &CancellationToken) {
    loop {
        let result = tokio::select! {
            biased;
            () = shutdown.cancelled() => return,
            result = drain_registry(ingestion) => result,
        };
        if let Err(error) = result {
            error!(%error, "could not decode the transaction registry");
            tokio::select! {
                () = shutdown.cancelled() => return,
                () = tokio::time::sleep(WRITE_RETRY_DELAY) => {},
            }
            continue;
        }
        tokio::select! {
            () = shutdown.cancelled() => return,
            () = ingestion.new_raw.notified() => {},
        }
    }
}

async fn drain_registry(ingestion: &Ingestion) -> Result<(), DecodeRunError> {
    let mut after = None;
    loop {
        let signatures = ingestion
            .store
            .decoded()
            .pending(DecodeScan {
                decoder: DECODER_NAME.to_owned(),
                decoder_version: DECODER_VERSION,
                after,
                limit: DECODE_BATCH_SIZE,
            })
            .await?;
        if signatures.is_empty() {
            return Ok(());
        }
        for signature in signatures {
            decode_one(ingestion, signature).await?;
            after = Some(signature);
        }
    }
}

async fn decode_one(ingestion: &Ingestion, signature: Signature) -> Result<(), DecodeRunError> {
    let registry = ingestion.store.raw_tx();
    let missing = || StoreError::InvalidStoredValue {
        what: "raw transaction for decoding",
        value: signature.to_string(),
    };
    let raw = registry.get(signature).await?.ok_or_else(missing)?;
    let decoded_at = ingestion.clock.now();
    let payload = match registry.payload(signature).await {
        Ok(payload) => payload.ok_or_else(missing)?,
        Err(error @ (StoreError::PayloadChecksumMismatch | StoreError::Compression { .. })) => {
            let record = record::unreadable(signature, decoded_at, error);
            ingestion
                .store
                .decoded()
                .replace_for_signature(record)
                .await?;
            return Ok(());
        }
        Err(error) => return Err(error.into()),
    };
    let record =
        tokio::task::spawn_blocking(move || record::decode(&raw, &payload, decoded_at)).await?;
    ingestion
        .store
        .decoded()
        .replace_for_signature(record)
        .await?;
    Ok(())
}

#[cfg(test)]
mod tests;
