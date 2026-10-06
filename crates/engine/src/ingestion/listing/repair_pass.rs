//! One repair of a wallet's listing: its signatures listed again, page by page, from the newest
//! down to the last point a repair verified, and compared with its rows.
//!
//! The listing is made at the finalized commitment, so it is the truth: a signature it holds that
//! the wallet does not list is a gap, written with its fetch task (or marked fetched if the
//! registry holds its transaction: nothing is downloaded twice), and a listed signature whose
//! fetch kept coming back empty is brought forward. Signatures newer than the cursor's top are
//! left to the top-up, and the cursor is never moved. Each page is written as soon as it is
//! listed; a repair stopped halfway goes on later from where it stopped, and one that could not
//! end starts over from the newest signature. When a repair ends, the newest signature it
//! compared that is old enough to be settled (`repair_rules`) becomes the point the next repair
//! stops at. A repair of the whole history that ends above the wallet's oldest listed signature
//! did not reach its first transaction: it fails, and is tried again.

use binsight_chain::{CallContext, SignaturesRequest};
use binsight_core::credits::{Priority, Purpose};
use binsight_solana::{Address, Signature};
use binsight_store::{ListedTop, RepairFindings, RepairPage, WalletRepair};
use jiff::Timestamp;
use tracing::{debug, warn};

use super::page_listing::{PageError, list_page, listed_signatures};
use super::repair_rules::{RepairRead, read_repair_page, settled_before};
use super::repair_schedule::RepairRange;
use crate::ingestion::Ingestion;

/// The class repairs are listed at.
pub(super) const REPAIR_CLASS: Priority = Priority::History;

/// The class the gaps a repair finds are fetched at.
const GAP_FETCH_CLASS: Priority = Priority::CatchUp;

/// A repair in progress.
#[derive(Debug)]
pub(super) struct RepairPass {
    range: RepairRange,
    started_at: Timestamp,
    before: Option<Signature>,
    settled: Option<ListedTop>,
    lowest_slot: Option<u64>,
    findings: RepairFindings,
    pages: u32,
    pub(super) retry_at: Option<Timestamp>,
}

impl RepairPass {
    pub(super) fn new(range: RepairRange, now: Timestamp) -> Self {
        Self {
            range,
            started_at: now,
            before: None,
            settled: None,
            lowest_slot: None,
            findings: RepairFindings::default(),
            pages: 0,
            retry_at: None,
        }
    }

    /// The wallet repaired.
    pub(super) fn wallet(&self) -> Address {
        self.range.wallet
    }

    /// Lists and writes the next page; returns whether the repair ended with it.
    pub(super) async fn advance(&mut self, ingestion: &Ingestion) -> Result<bool, PageError> {
        let wallet = self.range.wallet;
        let request = SignaturesRequest {
            address: wallet,
            before: self.before,
            until: self.range.floor.map(|floor| floor.signature),
        };
        let context = CallContext {
            priority: REPAIR_CLASS,
            purpose: Purpose::Repair,
            wallet: Some(wallet),
        };
        let page = list_page(ingestion, request, context).await?;
        let read = read_repair_page(&self.range, &page);
        self.write(ingestion, &read).await?;
        self.pages = self.pages.saturating_add(1);
        self.before = page.last().map(|oldest| oldest.signature);
        self.lowest_slot = page.last().map(|oldest| oldest.slot).or(self.lowest_slot);
        if !read.reached_floor {
            return Ok(false);
        }
        if let Err(error) = self.end(ingestion).await {
            self.start_over();
            return Err(error);
        }
        Ok(true)
    }

    /// Makes the next attempt list from the newest signature again: what this attempt found is
    /// written already, but it did not end.
    fn start_over(&mut self) {
        self.before = None;
        self.settled = None;
        self.lowest_slot = None;
    }

    async fn write(&mut self, ingestion: &Ingestion, read: &RepairRead) -> Result<(), PageError> {
        let settled_at = settled_before(self.started_at);
        self.settled = self.settled.or_else(|| read.newest_settled(settled_at));
        if read.in_range.is_empty() {
            return Ok(());
        }
        let page = RepairPage {
            wallet: self.range.wallet,
            signatures: listed_signatures(&read.in_range),
            fetch_priority: GAP_FETCH_CLASS,
            listed_at: ingestion.clock.now(),
        };
        let found = ingestion.store.repairs().record_page(page).await?;
        if found != RepairFindings::default() {
            ingestion.new_tasks.notify_one();
            ingestion.sync_changed.notify_one();
        }
        self.findings.missing = self.findings.missing.saturating_add(found.missing);
        self.findings.brought_forward = self
            .findings
            .brought_forward
            .saturating_add(found.brought_forward);
        Ok(())
    }

    /// Checks that a repair of the whole history reached the first transaction, then records
    /// the point it verified.
    async fn end(&self, ingestion: &Ingestion) -> Result<(), PageError> {
        let wallet = self.range.wallet;
        let repairs = ingestion.store.repairs();
        if self.range.floor.is_none() {
            let oldest = repairs.oldest_listed_slot(wallet).await?;
            if oldest.is_some_and(|oldest| self.lowest_slot.is_none_or(|lowest| oldest < lowest)) {
                return Err(PageError::StoppedEarly);
            }
        }
        let verified = self.settled.or(self.range.floor);
        let repaired_at = Some(ingestion.clock.now());
        repairs
            .record(WalletRepair {
                wallet,
                verified,
                repaired_at,
            })
            .await?;
        let RepairFindings {
            missing,
            brought_forward,
        } = self.findings;
        let is_full = self.range.floor.is_none();
        if missing > 0 || brought_forward > 0 {
            warn!(%wallet, missing, brought_forward, pages = self.pages, is_full,
                "a repair found transactions an earlier listing missed; they are fetched");
        } else {
            debug!(%wallet, pages = self.pages, is_full, "repair found nothing missing");
        }
        Ok(())
    }
}
