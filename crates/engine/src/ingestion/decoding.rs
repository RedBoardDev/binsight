//! Decodes each transaction of the registry once per decoder version, without network calls.
//!
//! At startup the decoder scans the whole registry once, which is how a new decoder version
//! re-decodes everything. After that, each fetch wakes it and it only reads the transactions
//! inserted since its previous scan ([`RegistryPosition`]), so the work follows what was fetched,
//! not the size of the registry.
//!
//! One transaction can never stop the others: whatever goes wrong with it (an unreadable
//! payload, a decoder error, even a panic of the decoder) is recorded as a failed result with its
//! error, and the decoder moves on. Decoding is a pure function of the immutable payload, the
//! transaction reader and the DLMM decoder, and a result records the versions of both: a failed
//! transaction is not tried again until one of them changes. How many failed is counted after
//! each scan and published for the sync report (logged too after the startup scan). Only a
//! database failure stops a scan; it is retried after a delay from where it stopped.
//!
//! The results tell which transactions hold DLMM activity the decoder reads and how each one
//! executed; the producer of the position figures selects its transactions from them. With each
//! result, the decoder records what the transaction left in the token accounts the tracked
//! wallets own, which the daily comparison with the chain reads.

mod record;
mod token_balances;

use std::collections::HashSet;
use std::sync::Arc;

use binsight_dlmm::{DECODER_NAME, DECODER_VERSION};
use binsight_solana::transaction::READER_VERSION;
use binsight_solana::{Address, Signature};
use binsight_store::{DecodeScan, RawTxRecord, RegistryPosition, StoreError};
use jiff::Timestamp;
use tokio_util::sync::CancellationToken;
use tracing::{error, warn};

use super::{Ingestion, STORE_RETRY_DELAY};
use record::Decoding;

const DECODE_BATCH_SIZE: u16 = 500;

/// The wallets whose token accounts the decoder records.
type TrackedWallets = Arc<HashSet<Address>>;

/// Decodes the registry until `shutdown` is cancelled.
pub(super) async fn run_decoder(ingestion: &Ingestion, shutdown: &CancellationToken) {
    let mut position = RegistryPosition::START;
    let mut is_first_scan = true;
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
        let failed = publish_failures(ingestion).await;
        if is_first_scan && failed.is_some_and(|failed| failed > 0) {
            warn!(
                ?failed,
                "some transactions could not be decoded; see the sync report"
            );
        }
        is_first_scan = false;
        tokio::select! {
            () = shutdown.cancelled() => return,
            () = ingestion.new_raw.notified() => {},
        }
    }
}

/// Counts the transactions the decoder could not read and publishes the count for the sync
/// report, so a request never counts them itself. A scan is the only thing that changes it.
async fn publish_failures(ingestion: &Ingestion) -> Option<u64> {
    match ingestion.store.decoded().failed_count().await {
        Ok(failed) => {
            ingestion.sync.failed_decodes.send_replace(Some(failed));
            Some(failed)
        }
        Err(error) => {
            error!(%error, "could not count the transactions that failed to decode");
            None
        }
    }
}

/// Decodes what waits after `position`, batch by batch, and moves `position` past each batch
/// once it is recorded.
async fn decode_new(
    ingestion: &Ingestion,
    position: &mut RegistryPosition,
) -> Result<(), StoreError> {
    let wallets: TrackedWallets = Arc::new(
        ingestion
            .store
            .wallets()
            .list()
            .await?
            .into_iter()
            .map(|wallet| wallet.address)
            .collect(),
    );
    loop {
        let backlog = ingestion
            .store
            .decoded()
            .pending(DecodeScan {
                decoder: DECODER_NAME.to_owned(),
                decoder_version: DECODER_VERSION,
                reader_version: READER_VERSION,
                after: *position,
                limit: DECODE_BATCH_SIZE,
            })
            .await?;
        for signature in backlog.signatures {
            decode_one(ingestion, signature, &wallets).await?;
        }
        *position = backlog.scanned_to;
        if !backlog.is_truncated {
            return Ok(());
        }
    }
}

async fn decode_one(
    ingestion: &Ingestion,
    signature: Signature,
    wallets: &TrackedWallets,
) -> Result<(), StoreError> {
    let raw = ingestion
        .store
        .raw_tx()
        .get(signature)
        .await?
        .ok_or_else(|| StoreError::InvalidStoredValue {
            what: "raw transaction for decoding",
            value: signature.to_string(),
        })?;
    let decoding = decode_isolated(
        raw,
        ingestion.clock.now(),
        wallets.clone(),
        record::decode_stored,
    )
    .await;
    ingestion
        .store
        .decoded()
        .record_with_balances(decoding.record, decoding.token_accounts)
        .await
}

/// Decodes `raw` with `decode` for the tracked `wallets`, on a blocking thread. A panic is caught
/// there and becomes the failed result of this one transaction.
async fn decode_isolated(
    raw: RawTxRecord,
    decoded_at: Timestamp,
    wallets: TrackedWallets,
    decode: fn(&RawTxRecord, Timestamp, &HashSet<Address>) -> Decoding,
) -> Decoding {
    let signature = raw.signature;
    match tokio::task::spawn_blocking(move || decode(&raw, decoded_at, &wallets)).await {
        Ok(decoding) => decoding,
        Err(stopped) => {
            warn!(%signature, error = %stopped, "the decoder stopped on a transaction; recorded as failed");
            Decoding::verdict_only(record::unreadable(
                signature,
                decoded_at,
                "the decoder stopped on this transaction",
            ))
        }
    }
}

#[cfg(test)]
mod tests;
