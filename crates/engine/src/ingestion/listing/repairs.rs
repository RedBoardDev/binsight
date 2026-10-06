//! The repairs the listing worker runs: the one due next, and the one running.
//!
//! One repair runs at a time, a page per step, between the more urgent listings; a repair whose
//! wallet stopped being tracked is dropped. Where each wallet's repair stands is read from the
//! database only when no repair runs, so an idle worker reads it once per wake-up at most.

use binsight_solana::Address;
use binsight_store::TrackedWallet;
use jiff::Timestamp;
use tracing::error;

use super::page_listing::PageError;
use super::repair_pass::RepairPass;
use super::repair_schedule::{NextRepair, RepairSchedule};
use crate::ingestion::{Ingestion, STORE_RETRY_DELAY};

/// When a repair is due.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum RepairDue {
    /// Now: a repair is running and its next page is due.
    Now,
    /// At this instant.
    At(Timestamp),
    /// No wallet can be repaired.
    Never,
}

/// The repair schedule and the running repair.
#[derive(Debug, Default)]
pub(super) struct Repairs {
    schedule: RepairSchedule,
    running: Option<RepairPass>,
}

impl Repairs {
    /// When the next repair page among `wallets` is due at `now`; a repair that falls due is
    /// started.
    pub(super) async fn due(
        &mut self,
        ingestion: &Ingestion,
        wallets: &[TrackedWallet],
        now: Timestamp,
    ) -> RepairDue {
        let is_tracked = |wallet: Address| wallets.iter().any(|tracked| tracked.address == wallet);
        self.running = self.running.take().filter(|pass| is_tracked(pass.wallet()));
        if let Some(pass) = &self.running {
            return match pass.retry_at.filter(|retry_at| *retry_at > now) {
                Some(retry_at) => RepairDue::At(retry_at),
                None => RepairDue::Now,
            };
        }
        let repairs = match ingestion.store.repairs().list().await {
            Ok(repairs) => repairs,
            Err(error) => {
                error!(%error, "could not read where the repairs stand");
                return RepairDue::At(now.checked_add(STORE_RETRY_DELAY).unwrap_or(now));
            }
        };
        match self.schedule.next(wallets, &repairs, now) {
            NextRepair::Repair(range) => {
                self.running = Some(RepairPass::new(range, now));
                RepairDue::Now
            }
            NextRepair::WaitUntil(at) => RepairDue::At(at),
            NextRepair::Nothing => RepairDue::Never,
        }
    }

    /// Lists and writes the running repair's next page; a repair that ends is let go. On a
    /// failure, returns its wallet and the error.
    pub(super) async fn advance(
        &mut self,
        ingestion: &Ingestion,
    ) -> Result<(), (Address, PageError)> {
        let Some(pass) = self.running.as_mut() else {
            return Ok(());
        };
        let wallet = pass.wallet();
        match pass.advance(ingestion).await {
            Ok(false) => Ok(()),
            Ok(true) => {
                self.running = None;
                self.schedule.ended(wallet);
                Ok(())
            }
            Err(error) => Err((wallet, error)),
        }
    }

    /// Holds the running repair of `wallet` back after a failure at `now`; returns how many
    /// failed in a row, and when it is tried again.
    pub(super) fn hold_back(&mut self, wallet: Address, now: Timestamp) -> (u32, Timestamp) {
        let (failures, retry_at) = self.schedule.failed(wallet, now);
        if let Some(pass) = self.running.as_mut().filter(|pass| pass.wallet() == wallet) {
            pass.retry_at = Some(retry_at);
        }
        (failures, retry_at)
    }
}

#[cfg(test)]
#[path = "tests/repair_support.rs"]
mod repair_support;

#[cfg(test)]
#[path = "tests/repair_gaps.rs"]
mod gap_tests;

#[cfg(test)]
#[path = "tests/repair_decisions.rs"]
mod decision_tests;

#[cfg(test)]
#[path = "tests/repair_credits.rs"]
mod credit_tests;
