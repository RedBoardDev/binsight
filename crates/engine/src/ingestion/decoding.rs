//! Decodes each transaction of the registry once per decoder version, without network calls.
//!
//! At startup the decoder scans the whole registry once, which is how a new decoder version
//! re-decodes everything. After that, each fetch wakes it and it only reads the transactions
//! inserted since its previous scan ([`RegistryPosition`]), so the work follows what was fetched,
//! not the size of the registry.
//!
//! One transaction can never stop the others: whatever goes wrong with it (an unreadable
//! payload, a decoder error, even a panic of the decoder) is recorded as a failed result with its
//! error, and the decoder moves on. Decoding is a pure function of the immutable payload, so a
//! failed transaction is not tried again at the same decoder version: the next version retries
//! it. Only a database failure stops a scan; it is retried after a delay from where it stopped.

mod record;

use std::time::Duration;

use binsight_dlmm::{DECODER_NAME, DECODER_VERSION};
use binsight_solana::Signature;
use binsight_store::{DecodeRecord, DecodeScan, RawTxRecord, RegistryPosition, StoreError};
use jiff::Timestamp;
use tokio_util::sync::CancellationToken;
use tracing::{error, warn};

use super::Ingestion;

const DECODE_BATCH_SIZE: u16 = 500;
const STORE_RETRY_DELAY: Duration = Duration::from_secs(30);

/// Decodes the registry until `shutdown` is cancelled.
pub(super) async fn run_decoder(ingestion: &Ingestion, shutdown: &CancellationToken) {
    let mut position = RegistryPosition::START;
    loop {
        let result = tokio::select! {
            biased;
            () = shutdown.cancelled() => return,
            result = decode_new(ingestion, &mut position) => result,
        };
        if let Err(error) = result {
            error!(%error, "could not decode the transaction registry");
            tokio::select! {
                () = shutdown.cancelled() => return,
                () = tokio::time::sleep(STORE_RETRY_DELAY) => {},
            }
            continue;
        }
        tokio::select! {
            () = shutdown.cancelled() => return,
            () = ingestion.new_raw.notified() => {},
        }
    }
}

/// Decodes what waits after `position`, batch by batch, and moves `position` past each batch
/// once it is recorded.
async fn decode_new(
    ingestion: &Ingestion,
    position: &mut RegistryPosition,
) -> Result<(), StoreError> {
    loop {
        let backlog = ingestion
            .store
            .decoded()
            .pending(DecodeScan {
                decoder: DECODER_NAME.to_owned(),
                decoder_version: DECODER_VERSION,
                after: *position,
                limit: DECODE_BATCH_SIZE,
            })
            .await?;
        for signature in backlog.signatures {
            decode_one(ingestion, signature).await?;
        }
        *position = backlog.scanned_to;
        if !backlog.is_truncated {
            return Ok(());
        }
    }
}

async fn decode_one(ingestion: &Ingestion, signature: Signature) -> Result<(), StoreError> {
    let raw = ingestion
        .store
        .raw_tx()
        .get(signature)
        .await?
        .ok_or_else(|| StoreError::InvalidStoredValue {
            what: "raw transaction for decoding",
            value: signature.to_string(),
        })?;
    let record = decode_isolated(raw, ingestion.clock.now(), record::decode_stored).await;
    ingestion
        .store
        .decoded()
        .replace_for_signature(record)
        .await
}

/// Decodes `raw` with `decode` on a blocking thread. A panic is caught there and becomes the
/// failed result of this one transaction.
async fn decode_isolated(
    raw: RawTxRecord,
    decoded_at: Timestamp,
    decode: fn(&RawTxRecord, Timestamp) -> DecodeRecord,
) -> DecodeRecord {
    let signature = raw.signature;
    match tokio::task::spawn_blocking(move || decode(&raw, decoded_at)).await {
        Ok(record) => record,
        Err(stopped) => {
            warn!(%signature, error = %stopped, "the decoder stopped on a transaction; recorded as failed");
            record::unreadable(
                signature,
                decoded_at,
                "the decoder stopped on this transaction",
            )
        }
    }
}

#[cfg(test)]
mod tests;
