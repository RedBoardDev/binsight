//! The source of figures in chain mode: what the engine already knows, read from its state.
//!
//! The engine knows the tracked wallets, how far each one is imported and how up to date it is,
//! the credits it spent and the instance settings, so the sync report, the settings and the
//! wallet list are served from them. The figures themselves (net worth, PnL, positions) are not
//! computed yet: those reads answer "not ready" (`figures`), and so do the wallet figures, which
//! are unavailable.

mod figures;
mod wallet_lines;

use std::sync::Arc;

use binsight_chain::RpcClient;
use binsight_core::clock::Clock;
use binsight_ledger::report::valued::Currency;
use binsight_store::{Store, StoreError, WalletProgress};
use jiff::Timestamp;
use jiff::tz::TimeZone;
use tokio::sync::watch;
use tracing::error;

use super::answer::{Answer, answered};
use super::instance_status::InstanceStatus;
use super::query::report_of;
use super::read_error::ReadError;
use super::read_model::{InstanceReads, WalletReads};
use super::views::{
    BillingCycle, ChainTip, InstanceSettings, SyncReport, SyncState, WalletSyncLine, WalletsView,
};
use crate::engine::status::EngineStatus;
use crate::ingestion::PublishedStatuses;
use wallet_lines::{WalletFacts, summary, sync_line, total};

/// What the engine knows, as the API reads it.
pub(crate) struct ChainPortfolio {
    store: Store,
    rpc: RpcClient,
    clock: Arc<dyn Clock>,
    started_at: Timestamp,
    status: watch::Receiver<EngineStatus>,
    sync_statuses: watch::Receiver<PublishedStatuses>,
}

/// Where the engine's state lives, for [`ChainPortfolio::new`].
pub(crate) struct EngineState {
    /// The database.
    pub(crate) store: Store,
    /// The chain client, for the credits it spent.
    pub(crate) rpc: RpcClient,
    /// The clock.
    pub(crate) clock: Arc<dyn Clock>,
    /// The engine's lifecycle status.
    pub(crate) status: watch::Receiver<EngineStatus>,
    /// Each wallet's progress and sync state, as the sync monitor last decided them.
    pub(crate) sync_statuses: watch::Receiver<PublishedStatuses>,
}

impl ChainPortfolio {
    /// The source of an engine starting now.
    pub(crate) fn new(state: EngineState) -> Self {
        Self {
            started_at: state.clock.now(),
            store: state.store,
            rpc: state.rpc,
            clock: state.clock,
            status: state.status,
            sync_statuses: state.sync_statuses,
        }
    }

    /// Every tracked wallet, the oldest first, with its sync line: from the sync monitor's last
    /// decision, or read from the database until it made one.
    async fn wallet_lines(
        &self,
        now: Timestamp,
    ) -> Result<Vec<(binsight_store::TrackedWallet, WalletSyncLine)>, ReadError> {
        let published = self.sync_statuses.borrow().clone();
        let statuses: Vec<(WalletProgress, Option<SyncState>)> = match published {
            Some(statuses) => statuses
                .iter()
                .map(|status| (status.progress, Some(status.state)))
                .collect(),
            None => self
                .store
                .wallets()
                .progress()
                .await
                .map_err(|failure| database_error(&failure))?
                .into_iter()
                .map(|progress| (progress, None))
                .collect(),
        };
        Ok(statuses
            .into_iter()
            .enumerate()
            .map(|(position, (progress, state))| {
                let facts = WalletFacts {
                    wallet: progress.wallet,
                    position,
                    state,
                    backlog: progress.backlog,
                    listing: progress.listing,
                };
                (progress.wallet, sync_line(&facts, now))
            })
            .collect())
    }

    /// The engine's lifecycle and the credits of the billing cycle.
    fn instance_status(&self) -> Result<InstanceStatus, ReadError> {
        let standing = self.rpc.credit_meter().standing();
        let cycle_start = standing
            .cycle_first_day
            .to_zoned(TimeZone::UTC)
            .map_err(|_| ReadError::MissingFact)?
            .timestamp();
        Ok(InstanceStatus {
            engine: *self.status.borrow(),
            started_at: self.started_at,
            chain: ChainTip::default(),
            valuation_interval_seconds: None,
            credit_cycle: BillingCycle {
                start: cycle_start,
                end: standing.cycle_resets_at,
            },
            credits_used: standing.spent_cycle.0,
            credits_budget: standing.cycle_credits.0,
        })
    }
}

impl InstanceReads for ChainPortfolio {
    fn sync_report(&self) -> Answer<'_, SyncReport> {
        Box::pin(async move {
            let now = self.clock.now();
            let wallets: Vec<WalletSyncLine> = self
                .wallet_lines(now)
                .await?
                .into_iter()
                .map(|(_, line)| line)
                .collect();
            let status = self.instance_status()?;
            report_of(wallets, &status, now)
        })
    }

    fn settings(&self) -> Answer<'_, InstanceSettings> {
        answered(Ok(InstanceSettings::default()))
    }
}

impl WalletReads for ChainPortfolio {
    fn wallets(&self, _currency: Currency) -> Answer<'_, WalletsView> {
        Box::pin(async move {
            let lines = self.wallet_lines(self.clock.now()).await?;
            let total = total(lines.iter().map(|(_, line)| line));
            Ok(WalletsView {
                items: lines
                    .iter()
                    .map(|(wallet, line)| summary(line, wallet.added_at))
                    .collect(),
                total,
            })
        })
    }
}

/// Logs a database failure and turns it into the read error the API answers with.
fn database_error(failure: &StoreError) -> ReadError {
    error!(error = %failure, "could not read the engine's state for the portfolio");
    ReadError::Database
}

#[cfg(test)]
mod tests;
