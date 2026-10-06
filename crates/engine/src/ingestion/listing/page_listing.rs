//! Listing one page of signatures, and why a listing step did not complete.
//!
//! Every listing (a history page, a top-up page) asks the chain client for one page and sorts its
//! failures the same way: a class the budget defers, a refusal that pauses every request, an
//! error of this request, or a database failure while writing what was listed. This module lists,
//! turns a page into the signatures to write, and names the failures; what a page means for the
//! cursor belongs to the listing that asked.

use binsight_chain::{CallContext, RpcError, SignatureInfo, SignaturesRequest};
use binsight_store::{ListedSignature, StoreError};
use jiff::Timestamp;

use crate::ingestion::Ingestion;
use crate::ingestion::refusal::{Refusal, refusal_of};

/// Why a listing step did not complete.
#[derive(Debug, thiserror::Error)]
pub(super) enum PageError {
    /// The credit budget holds this class of listing back until this instant.
    #[error("listing deferred by the credit budget until {until}")]
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
    /// The page could not be written, or what it builds on could not be read.
    #[error(transparent)]
    Store(#[from] StoreError),
}

/// Lists the page `request` asks for, as `context` says.
pub(super) async fn list_page(
    ingestion: &Ingestion,
    request: SignaturesRequest,
    context: CallContext,
) -> Result<Vec<SignatureInfo>, PageError> {
    let error = match ingestion.rpc.signatures_for_address(request, context).await {
        Ok(page) => return Ok(page),
        Err(error) => error,
    };
    Err(match refusal_of(&error, ingestion.clock.now()) {
        Some(Refusal::Deferred(until)) => PageError::Deferred { until },
        Some(Refusal::Paused(until)) => PageError::Paused {
            until,
            reason: error,
        },
        None => PageError::Rpc(error),
    })
}

/// The signatures of a listed page, as they are written.
pub(super) fn listed_signatures(page: &[SignatureInfo]) -> Vec<ListedSignature> {
    page.iter()
        .map(|entry| ListedSignature {
            signature: entry.signature,
            slot: entry.slot,
            block_time: entry.block_time,
            is_failed: entry.is_failed,
        })
        .collect()
}
