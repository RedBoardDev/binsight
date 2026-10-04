//! The source of figures while the engine cannot serve any: every read answers "not ready".

use binsight_ledger::report::valued::Currency;
use binsight_solana::Address;

use super::answer::{Answer, answered};
use super::query::{OpenPositionsRequest, OverviewRequest, SeriesRequest};
use super::read_error::ReadError;
use super::read_model::{InstanceReads, PortfolioReads, PositionReads, StatsReads, WalletReads};
use super::scope::Scope;
use super::views::{
    InstanceSettings, OpenPositionsView, OverviewView, RecentClosesView, SeriesView, SyncReport,
    TokenLogoImage, WalletsView,
};

/// A source that has no figures yet.
#[derive(Debug, Clone, Copy, Default)]
pub struct NotReadyPortfolio;

impl InstanceReads for NotReadyPortfolio {
    fn sync_report(&self) -> Answer<'_, SyncReport> {
        answered(Err(ReadError::NotReady))
    }

    fn settings(&self) -> Answer<'_, InstanceSettings> {
        answered(Err(ReadError::NotReady))
    }
}

impl WalletReads for NotReadyPortfolio {
    fn wallets(&self, _currency: Currency) -> Answer<'_, WalletsView> {
        answered(Err(ReadError::NotReady))
    }
}

impl PortfolioReads for NotReadyPortfolio {
    fn overview(&self, _request: OverviewRequest) -> Answer<'_, OverviewView> {
        answered(Err(ReadError::NotReady))
    }

    fn open_positions(&self, _request: OpenPositionsRequest) -> Answer<'_, OpenPositionsView> {
        answered(Err(ReadError::NotReady))
    }

    fn recent_closes(&self, _scope: Scope, _currency: Currency) -> Answer<'_, RecentClosesView> {
        answered(Err(ReadError::NotReady))
    }
}

impl StatsReads for NotReadyPortfolio {
    fn stats_series(&self, _request: SeriesRequest) -> Answer<'_, SeriesView> {
        answered(Err(ReadError::NotReady))
    }
}

impl PositionReads for NotReadyPortfolio {
    fn token_logo(&self, _mint: Address) -> Answer<'_, TokenLogoImage> {
        answered(Err(ReadError::NotReady))
    }
}
