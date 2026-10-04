//! Listing one page of a wallet's history and writing it.
//!
//! A page is listed at the catch-up priority (one credit lists up to a thousand signatures, and
//! knowing the whole history first gives an exact progress), then its signatures are ranked in
//! their slots and written with their fetch tasks and the cursor move, in one transaction. A
//! short page is written too, but leaves the cursor where it was until a second listing confirms
//! it ends the history. A page that cannot be listed or written changes nothing. Which page comes
//! next is the listing worker's decision; the cursor rules live in `history_cursor`.

use binsight_chain::{CallContext, RpcError, SignatureInfo, SignaturesRequest};
use binsight_core::credits::{Priority, Purpose};
use binsight_store::{ListingPage, StoreError, TrackedWallet, WalletCursor};
use jiff::Timestamp;
use tracing::{debug, info};

use super::history_cursor::{HistoryStep, step_after_history_page};
use super::history_end::ListedEnd;
use super::slot_order::{PageBoundary, rank_in_slots};
use crate::ingestion::Ingestion;
use crate::ingestion::refusal::{Refusal, refusal_of};

/// Why a page was not written.
#[derive(Debug, thiserror::Error)]
pub(super) enum PageError {
    /// The credit budget holds history listings back until this instant.
    #[error("history listing deferred by the credit budget until {until}")]
    Deferred {
        /// When listing may resume.
        until: Timestamp,
    },
    /// The provider refuses every request until this instant.
    #[error("{reason}")]
    Paused {
        /// When work may resume.
        until: Timestamp,
        /// The refusal.
        reason: RpcError,
    },
    /// The page could not be listed.
    #[error(transparent)]
    Rpc(RpcError),
    /// The page could not be written, or where the previous page ended could not be read.
    #[error(transparent)]
    Store(#[from] StoreError),
}

/// Lists one page of `wallet`'s history and writes it. `unconfirmed_end` is the short page an
/// earlier listing of the same page returned, if any. Returns the page if it may end the history
/// and still needs a confirmation.
pub(super) async fn list_and_write(
    ingestion: &Ingestion,
    wallet: &TrackedWallet,
    request: SignaturesRequest,
    unconfirmed_end: Option<&ListedEnd>,
) -> Result<Option<ListedEnd>, PageError> {
    let context = CallContext {
        priority: Priority::CatchUp,
        purpose: Purpose::HistoryListing,
        wallet: Some(wallet.address),
    };
    let page = match ingestion.rpc.signatures_for_address(request, context).await {
        Ok(page) => page,
        Err(error) => {
            return Err(match refusal_of(&error, ingestion.clock.now()) {
                Some(Refusal::Deferred(until)) => PageError::Deferred { until },
                Some(Refusal::Paused(until)) => PageError::Paused {
                    until,
                    reason: error,
                },
                None => PageError::Rpc(error),
            });
        }
    };
    let step = step_after_history_page(&wallet.cursor, &request, &page, unconfirmed_end);
    write_page(ingestion, wallet, request, &page, &step).await?;
    Ok(match step {
        HistoryStep::MoveTo(_) => None,
        HistoryStep::ConfirmEnd(end) => Some(end),
    })
}

/// Ranks the page's signatures and writes them with the cursor `step` leads to.
async fn write_page(
    ingestion: &Ingestion,
    wallet: &TrackedWallet,
    request: SignaturesRequest,
    page: &[SignatureInfo],
    step: &HistoryStep,
) -> Result<(), StoreError> {
    let store = &ingestion.store;
    let boundary = match request.before {
        None => None,
        Some(before) => store
            .signatures()
            .get(wallet.address, before)
            .await?
            .and_then(|previous| {
                previous.slot_order.map(|slot_order| PageBoundary {
                    slot: previous.slot,
                    slot_order,
                })
            }),
    };
    let cursor = match step {
        HistoryStep::MoveTo(cursor) => *cursor,
        HistoryStep::ConfirmEnd(_) => wallet.cursor,
    };
    let listing = ListingPage {
        wallet: wallet.address,
        signatures: rank_in_slots(page, boundary),
        previous_cursor: wallet.cursor,
        cursor,
        fetch_priority: Priority::History,
        listed_at: ingestion.clock.now(),
    };
    let new_signatures = store.signatures().record_listing(listing).await?;
    ingestion.new_tasks.notify_one();
    debug!(wallet = %wallet.address, listed = page.len(), new_signatures, "history page listed");
    match (step, cursor) {
        (HistoryStep::ConfirmEnd(_), _) => {
            debug!(wallet = %wallet.address, "short page listed; the end of the history is confirmed later");
        }
        (HistoryStep::MoveTo(_), WalletCursor::HistoryComplete { .. }) => {
            info!(wallet = %wallet.address, "history fully listed");
        }
        (HistoryStep::MoveTo(_), _) => {}
    }
    Ok(())
}
