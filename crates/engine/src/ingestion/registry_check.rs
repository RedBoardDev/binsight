//! The startup check of the registry: local, cheap, and no credit spent.
//!
//! Before any worker starts, the engine reads how far the registry's facts disagree (one read
//! snapshot, no payload read) and acts on each finding. What the database alone can restore is
//! restored at once: a counter is counted again, a listed signature without a task is queued (or
//! marked fetched when its transaction is stored), a task left open for a stored transaction is
//! marked fetched, and a task marked fetched without its transaction is queued again. A wallet
//! whose cursor or verified repair point names a signature it does not list is asked a full
//! repair, which the listing worker runs through the credit budget. Decoding results behind the
//! current versions are left to the decoder, which redoes them right after; transactions without
//! an index in their block are only reported, since their payload is never fetched again. Nothing
//! here crashes the engine: the result is published for the sync report.

use std::time::Instant;

use binsight_core::credits::Priority;
use binsight_dlmm::{DECODER_NAME, DECODER_VERSION};
use binsight_solana::Address;
use binsight_solana::transaction::READER_VERSION;
use binsight_store::{CurrentDecoder, RegistryInspection, Store, StoreError};
use jiff::Timestamp;
use tracing::{error, info, warn};

use crate::portfolio::views::{RegistryCheck, RegistryFinding, RegistryFindingKind};

/// What the engine publishes once the check ran: `None` until then, or if it could not run.
pub(crate) type PublishedRegistryCheck = Option<std::sync::Arc<RegistryCheck>>;

/// The class the transactions the check queues are fetched at: they are gaps of a history
/// already listed.
const REFILL_CLASS: Priority = Priority::CatchUp;

/// What the database alone restores, and the wallets whose listing is repaired in full.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct Restoration {
    recount: Vec<Address>,
    repair_in_full: Vec<Address>,
    mark_stored_fetched: bool,
    requeue_without_payload: bool,
    queue_unqueued: bool,
}

/// Checks the registry at `now`, restores what the database alone can, asks full repairs where
/// a cursor names signatures its wallet does not list, and returns what it found.
///
/// # Errors
///
/// Returns an error if the database cannot be read or written; what was restored before stays.
pub(crate) async fn check_registry(
    store: &Store,
    now: Timestamp,
) -> Result<RegistryCheck, StoreError> {
    let started = Instant::now();
    let inspection = store.consistency().inspect(current_decoder()).await?;
    let findings = findings_of(&inspection);
    restore(store, &restoration_of(&inspection), now).await?;
    let elapsed_ms = started.elapsed().as_millis();
    log_findings(&findings);
    info!(elapsed_ms, findings = findings.len(), "registry checked");
    Ok(RegistryCheck {
        checked_at: now,
        findings,
    })
}

/// What the registry `store` holds disagrees on, read without changing anything.
///
/// # Errors
///
/// Returns an error if the database cannot be read.
pub async fn read_registry_findings(store: &Store) -> Result<Vec<RegistryFinding>, StoreError> {
    let inspection = store.consistency().inspect(current_decoder()).await?;
    Ok(findings_of(&inspection))
}

fn current_decoder() -> CurrentDecoder {
    CurrentDecoder {
        name: DECODER_NAME.to_owned(),
        decoder_version: DECODER_VERSION,
        reader_version: READER_VERSION,
    }
}

/// What `inspection` found, one finding per kind that is not zero.
fn findings_of(inspection: &RegistryInspection) -> Vec<RegistryFinding> {
    let count_wallets = |is_wrong: fn(&binsight_store::WalletInspection) -> bool| {
        let wrong = inspection.wallets.iter().filter(|wallet| is_wrong(wallet));
        u64::try_from(wrong.count()).unwrap_or(u64::MAX)
    };
    let counts = [
        (
            RegistryFindingKind::WrongListedCounts,
            count_wallets(|wallet| wallet.counted != wallet.listed),
        ),
        (
            RegistryFindingKind::UnlistedCursorPoints,
            count_wallets(|wallet| !has_listed_points(wallet)),
        ),
        (
            RegistryFindingKind::UnqueuedSignatures,
            inspection.unqueued_signatures,
        ),
        (
            RegistryFindingKind::FetchedWithoutPayload,
            inspection.fetched_without_payload,
        ),
        (
            RegistryFindingKind::StoredButQueued,
            inspection.stored_but_queued,
        ),
        (
            RegistryFindingKind::UnreturnedTransactions,
            inspection.unreturned_transactions,
        ),
        (
            RegistryFindingKind::OutdatedDecodes,
            inspection.outdated_decodes,
        ),
        (
            RegistryFindingKind::UnorderedTransactions,
            inspection.unordered_transactions,
        ),
    ];
    counts
        .into_iter()
        .filter(|(_, count)| *count > 0)
        .map(|(kind, count)| RegistryFinding { kind, count })
        .collect()
}

/// Whether every point `wallet`'s cursor and repair name is among its listed signatures.
fn has_listed_points(wallet: &binsight_store::WalletInspection) -> bool {
    wallet.is_top_listed && wallet.is_history_page_listed && wallet.is_verified_point_listed
}

/// What to restore after `inspection`.
fn restoration_of(inspection: &RegistryInspection) -> Restoration {
    let wallets = |is_wrong: fn(&binsight_store::WalletInspection) -> bool| {
        inspection
            .wallets
            .iter()
            .filter(|wallet| is_wrong(wallet))
            .map(|wallet| wallet.wallet)
            .collect()
    };
    Restoration {
        recount: wallets(|wallet| wallet.counted != wallet.listed),
        repair_in_full: wallets(|wallet| !has_listed_points(wallet)),
        mark_stored_fetched: inspection.stored_but_queued > 0,
        requeue_without_payload: inspection.fetched_without_payload > 0,
        queue_unqueued: inspection.unqueued_signatures > 0,
    }
}

/// Applies `restoration` at `now`. Stored transactions are marked fetched before anything is
/// queued, so nothing the registry holds is ever queued.
async fn restore(
    store: &Store,
    restoration: &Restoration,
    now: Timestamp,
) -> Result<(), StoreError> {
    let consistency = store.consistency();
    for wallet in &restoration.recount {
        consistency.recount_listed(*wallet).await?;
    }
    for wallet in &restoration.repair_in_full {
        store.repairs().ask_full(*wallet).await?;
    }
    if restoration.mark_stored_fetched {
        consistency.mark_stored_fetched(now).await?;
    }
    if restoration.requeue_without_payload {
        consistency
            .requeue_fetched_without_payload(REFILL_CLASS, now)
            .await?;
    }
    if restoration.queue_unqueued {
        consistency
            .queue_unqueued_signatures(REFILL_CLASS, now)
            .await?;
    }
    Ok(())
}

/// Logs each finding: work the engine does anyway is information, a disagreement a warning, and a
/// fetched task without its transaction an error (the registry lost a row it had).
fn log_findings(findings: &[RegistryFinding]) {
    for RegistryFinding { kind, count } in findings {
        match kind {
            RegistryFindingKind::OutdatedDecodes | RegistryFindingKind::UnreturnedTransactions => {
                info!(?kind, count, "registry check: work to do");
            }
            RegistryFindingKind::FetchedWithoutPayload => {
                error!(
                    ?kind,
                    count, "registry check: fetched transactions are missing; queued again"
                );
            }
            RegistryFindingKind::UnorderedTransactions => {
                warn!(
                    ?kind,
                    count, "registry check: transactions cannot be ordered exactly"
                );
            }
            RegistryFindingKind::UnlistedCursorPoints => {
                warn!(
                    ?kind,
                    count, "registry check: listings are repaired in full"
                );
            }
            RegistryFindingKind::WrongListedCounts
            | RegistryFindingKind::UnqueuedSignatures
            | RegistryFindingKind::StoredButQueued => {
                warn!(?kind, count, "registry check: facts disagreed; restored");
            }
        }
    }
}

#[cfg(test)]
mod tests;
