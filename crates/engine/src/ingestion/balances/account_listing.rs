//! Listing a token account's signatures newer than the registry's last transaction for it, and
//! filling what its wallet lacks.
//!
//! A transaction that moved the account's tokens without naming its wallet is among them. The
//! listing stops at the registry's last transaction of the account, never below its slot, page
//! after page; each page's signatures are written under the wallet like a repair's (a gap is
//! listed and queued, a stored transaction marked fetched), at the catch-up priority, and the
//! cursor is left as it is.

use binsight_chain::{CallContext, SignaturesRequest};
use binsight_core::credits::{Priority, Purpose};
use binsight_store::{ListedTop, RepairFindings, RepairPage, TokenAccountBalance};

use crate::ingestion::Ingestion;
use crate::ingestion::listing::{PageError, list_page, listed_signatures, read_top_up_page};

/// The class the listing and the fetches it queues go at.
const LISTING_CLASS: Priority = Priority::CatchUp;

/// Lists `known.token_account`'s signatures newer than `known.signature` and writes them under
/// `known.wallet`; returns what that found.
pub(super) async fn list_token_account(
    ingestion: &Ingestion,
    known: &TokenAccountBalance,
) -> Result<RepairFindings, PageError> {
    let last = ListedTop {
        signature: known.signature,
        slot: known.slot,
    };
    let context = CallContext {
        priority: LISTING_CLASS,
        purpose: Purpose::TokenAccountListing,
        wallet: Some(known.wallet),
    };
    let mut found = RepairFindings::default();
    let mut before = None;
    loop {
        let request = SignaturesRequest {
            address: known.token_account,
            before,
            until: Some(known.signature),
        };
        let page = list_page(ingestion, request, context).await?;
        let read = read_top_up_page(Some(last), &page);
        if !read.newer.is_empty() {
            let written = RepairPage {
                wallet: known.wallet,
                signatures: listed_signatures(&read.newer),
                fetch_priority: LISTING_CLASS,
                listed_at: ingestion.clock.now(),
            };
            let page_found = ingestion.store.repairs().record_page(written).await?;
            found.missing = found.missing.saturating_add(page_found.missing);
            found.brought_forward = found
                .brought_forward
                .saturating_add(page_found.brought_forward);
            ingestion.new_tasks.notify_one();
            ingestion.sync_changed.notify_one();
        }
        if read.reached_top {
            return Ok(found);
        }
        before = page.last().map(|oldest| oldest.signature);
    }
}
