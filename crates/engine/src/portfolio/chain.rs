//! The source of figures in chain mode: what the engine already knows, read from its state.
//!
//! The engine knows the tracked wallets, how far each one is imported and how up to date it is,
//! the credits it spent and the instance settings, so the sync report, the settings and the
//! wallet list are served from them. The figures themselves (net worth, PnL, positions) are not
//! computed yet: those reads answer "not ready" (`figures`), and so do the wallet figures, which
//! are unavailable.

mod figures;
mod wallet_lines;

use std::collections::BTreeMap;
use std::sync::Arc;

use binsight_chain::RpcClient;
use binsight_core::clock::Clock;
use binsight_ledger::report::valued::Currency;
use binsight_solana::Address;
use binsight_store::{Store, StoreError};
use jiff::Timestamp;
use jiff::tz::TimeZone;
use tokio::sync::watch;
use tracing::error;

use super::answer::{Answer, answered};
use super::instance_status::InstanceStatus;
use super::query::credits;
use super::read_error::ReadError;
use super::read_model::{InstanceReads, WalletReads};
use super::views::{
    BillingCycle, ChainTip, InstanceSettings, SyncReport, SyncState, WalletSyncLine, WalletsView,
};
use crate::ingestion;
use crate::status::EngineStatus;
use wallet_lines::{WalletFacts, summary, sync_line, total};

/// What the engine knows, as the API reads it.
pub(crate) struct ChainPortfolio {
    store: Store,
    rpc: RpcClient,
    clock: Arc<dyn Clock>,
    started_at: Timestamp,
    status: watch::Receiver<EngineStatus>,
    sync_states: watch::Receiver<BTreeMap<Address, ingestion::SyncState>>,
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
    /// Each wallet's sync state, as last decided.
    pub(crate) sync_states: watch::Receiver<BTreeMap<Address, ingestion::SyncState>>,
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
            sync_states: state.sync_states,
        }
    }

    /// Every tracked wallet, the oldest first, with its sync line.
    async fn wallet_lines(
        &self,
        now: Timestamp,
    ) -> Result<Vec<(binsight_store::TrackedWallet, WalletSyncLine)>, ReadError> {
        let wallets = self
            .store
            .wallets()
            .list()
            .await
            .map_err(|failure| database_error(&failure))?;
        let backlogs = self
            .store
            .fetch_queue()
            .backlogs()
            .await
            .map_err(|failure| database_error(&failure))?;
        let listings = self
            .store
            .wallets()
            .listings()
            .await
            .map_err(|failure| database_error(&failure))?;
        let states = self.sync_states.borrow().clone();
        Ok(wallets
            .into_iter()
            .enumerate()
            .map(|(position, wallet)| {
                let facts = WalletFacts {
                    wallet,
                    position,
                    state: states.get(&wallet.address).copied(),
                    backlog: backlogs.get(&wallet.address).copied().unwrap_or_default(),
                    listing: listings.get(&wallet.address).copied().unwrap_or_default(),
                };
                (wallet, sync_line(&facts, now))
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
            Ok(SyncReport {
                state: wallets
                    .iter()
                    .map(|line| line.sync.state)
                    .max()
                    .unwrap_or(SyncState::Live),
                engine: status.engine,
                as_of: now,
                started_at: status.started_at,
                chain: status.chain,
                valuation_interval_seconds: status.valuation_interval_seconds,
                credits: credits(&status, now)?,
                wallets,
            })
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
