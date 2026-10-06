//! The figures the engine does not compute yet: every read of them answers "not ready".

use binsight_ledger::facts::PositionId;
use binsight_ledger::report::valued::Currency;
use binsight_solana::Address;

use super::ChainPortfolio;
use crate::portfolio::answer::{Answer, answered};
use crate::portfolio::query::{
    ClosedPageRequest, ClosedQuery, EventPageRequest, IntervalChoice, OpenPositionsRequest,
    OverviewRequest, PoolQuery, PositionRequest, SeriesRequest,
};
use crate::portfolio::read_error::ReadError;
use crate::portfolio::read_model::{HistoryReads, PortfolioReads, PositionReads, StatsReads};
use crate::portfolio::scope::Scope;
use crate::portfolio::views::{
    CandlesView, ClosedPage, EventPage, OpenPositionsView, OverviewView, PoolOption,
    PositionDetailView, RecentClosesView, SeriesView, TokenLogoImage,
};

impl PortfolioReads for ChainPortfolio {
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

impl StatsReads for ChainPortfolio {
    fn stats_series(&self, _request: SeriesRequest) -> Answer<'_, SeriesView> {
        answered(Err(ReadError::NotReady))
    }
}

impl PositionReads for ChainPortfolio {
    fn position(&self, _request: PositionRequest) -> Answer<'_, PositionDetailView> {
        answered(Err(ReadError::NotReady))
    }

    fn position_events(&self, _request: EventPageRequest) -> Answer<'_, EventPage> {
        answered(Err(ReadError::NotReady))
    }

    fn position_candles(
        &self,
        _id: PositionId,
        _interval: IntervalChoice,
    ) -> Answer<'_, CandlesView> {
        answered(Err(ReadError::NotReady))
    }

    fn token_logo(&self, _mint: Address) -> Answer<'_, TokenLogoImage> {
        answered(Err(ReadError::NotReady))
    }
}

impl HistoryReads for ChainPortfolio {
    fn closed_page(&self, _query: ClosedQuery, _page: ClosedPageRequest) -> Answer<'_, ClosedPage> {
        answered(Err(ReadError::NotReady))
    }

    fn pools(&self, _query: PoolQuery) -> Answer<'_, Vec<PoolOption>> {
        answered(Err(ReadError::NotReady))
    }
}
