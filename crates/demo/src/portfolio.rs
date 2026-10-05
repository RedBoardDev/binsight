//! The demo world as a source of figures: every read runs the engine's query on its snapshot.

use std::sync::Arc;

use binsight_core::clock::Clock;
use binsight_engine::portfolio::query::{
    ClosedPageRequest, ClosedQuery, EventPageRequest, IntervalChoice, OpenPositionsRequest,
    OverviewRequest, PoolQuery, PositionRequest, SeriesRequest,
};
use binsight_engine::portfolio::views::{
    CandlesView, ClosedPage, EventPage, InstanceSettings, OpenPositionsView, OverviewView,
    PoolOption, PositionDetailView, RecentClosesView, SeriesView, SyncReport, TokenLogoImage,
    WalletsView,
};
use binsight_engine::portfolio::{
    Answer, HistoryReads, InstanceReads, PortfolioReads, PositionReads, ReadContext, Scope,
    StatsReads, WalletReads, answered, query,
};
use binsight_ledger::facts::PositionId;
use binsight_ledger::report::valued::Currency;
use binsight_solana::Address;

use crate::candles::candles;
use crate::error::DemoError;
use crate::world::{World, WorldSpec};

/// A generated portfolio that answers the API's reads, as the engine will from the chain.
pub struct DemoPortfolio {
    world: World,
    clock: Arc<dyn Clock>,
}

impl DemoPortfolio {
    /// Generates the world of `spec`; reads happen at the time of `clock`.
    ///
    /// # Errors
    ///
    /// Returns [`DemoError`] if the scenario cannot be generated (never for the default one).
    pub fn new(spec: &WorldSpec, clock: Arc<dyn Clock>) -> Result<Self, DemoError> {
        Ok(Self {
            world: World::generate(spec)?,
            clock,
        })
    }

    /// The instant and time zone of a read now.
    fn context(&self) -> ReadContext {
        ReadContext {
            now: self.clock.now(),
            timezone: self.world.timezone.clone(),
        }
    }
}

impl std::fmt::Debug for DemoPortfolio {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("DemoPortfolio")
            .finish_non_exhaustive()
    }
}

impl InstanceReads for DemoPortfolio {
    fn sync_report(&self) -> Answer<'_, SyncReport> {
        let world = &self.world;
        answered(query::sync_report(
            &world.snapshot,
            &world.status,
            self.context().now,
        ))
    }

    fn settings(&self) -> Answer<'_, InstanceSettings> {
        answered(Ok(self.world.settings.clone()))
    }
}

impl WalletReads for DemoPortfolio {
    fn wallets(&self, currency: Currency) -> Answer<'_, WalletsView> {
        answered(query::wallets(
            &self.world.snapshot,
            &self.context(),
            currency,
        ))
    }
}

impl PortfolioReads for DemoPortfolio {
    fn overview(&self, request: OverviewRequest) -> Answer<'_, OverviewView> {
        let world = &self.world;
        answered(query::overview(
            &world.snapshot,
            &world.status,
            request,
            &self.context(),
        ))
    }

    fn open_positions(&self, request: OpenPositionsRequest) -> Answer<'_, OpenPositionsView> {
        answered(query::open_positions(
            &self.world.snapshot,
            request,
            &self.context(),
        ))
    }

    fn recent_closes(&self, scope: Scope, currency: Currency) -> Answer<'_, RecentClosesView> {
        answered(query::recent_closes(
            &self.world.snapshot,
            scope,
            currency,
            &self.context(),
        ))
    }
}

impl HistoryReads for DemoPortfolio {
    fn closed_page(&self, query: ClosedQuery, page: ClosedPageRequest) -> Answer<'_, ClosedPage> {
        answered(query::closed_page(
            &self.world.snapshot,
            &query,
            page,
            &self.context(),
        ))
    }

    fn pools(&self, query: PoolQuery) -> Answer<'_, Vec<PoolOption>> {
        answered(query::pools(&self.world.snapshot, &query))
    }
}

impl StatsReads for DemoPortfolio {
    fn stats_series(&self, request: SeriesRequest) -> Answer<'_, SeriesView> {
        answered(query::stats_series(
            &self.world.snapshot,
            request,
            &self.context(),
        ))
    }
}

impl PositionReads for DemoPortfolio {
    fn position(&self, request: PositionRequest) -> Answer<'_, PositionDetailView> {
        answered(query::position(
            &self.world.snapshot,
            request,
            &self.context(),
        ))
    }

    fn position_events(&self, request: EventPageRequest) -> Answer<'_, EventPage> {
        answered(query::position_events(&self.world.snapshot, request))
    }

    fn position_candles(
        &self,
        id: PositionId,
        interval: IntervalChoice,
    ) -> Answer<'_, CandlesView> {
        let world = &self.world;
        let now = self.context().now;
        answered(
            query::candle_request(&world.snapshot, id, interval, now).and_then(|request| {
                let address = request.pool.address;
                let path = world
                    .paths
                    .get(&address)
                    .filter(|_| world.unindexed_pool != Some(address));
                candles(&request, path, now)
            }),
        )
    }

    fn token_logo(&self, mint: Address) -> Answer<'_, TokenLogoImage> {
        answered(query::token_logo(&self.world.snapshot, mint))
    }
}

#[cfg(test)]
mod tests {
    use binsight_core::clock::FixedClock;
    use binsight_engine::portfolio::views::SyncState;
    use jiff::Timestamp;
    use jiff::tz::TimeZone;

    use super::*;

    fn portfolio() -> DemoPortfolio {
        let anchor: Timestamp = "2026-10-04T15:30:00Z".parse().unwrap();
        let spec = WorldSpec::new(anchor, TimeZone::get("Europe/Paris").unwrap());
        DemoPortfolio::new(&spec, Arc::new(FixedClock::new(anchor))).unwrap()
    }

    #[tokio::test]
    async fn reports_the_worst_wallet_state_as_the_instance_state() {
        let report = portfolio().sync_report().await.unwrap();

        assert_eq!(report.state, SyncState::Lagging);
        let states: Vec<SyncState> = report.wallets.iter().map(|line| line.sync.state).collect();
        assert_eq!(
            states,
            [SyncState::Live, SyncState::Lagging, SyncState::Live]
        );
    }

    #[tokio::test]
    async fn counts_every_open_position_in_the_wallets_and_their_total() {
        let wallets = portfolio().wallets(Currency::Sol).await.unwrap();

        let open: usize = wallets.items.iter().map(|wallet| wallet.open_count).sum();
        let out_of_range: usize = wallets
            .items
            .iter()
            .map(|wallet| wallet.out_of_range_count)
            .sum();
        assert_eq!((open, wallets.total.open_count), (8, 8));
        assert_eq!((out_of_range, wallets.total.out_of_range_count), (2, 2));
        let closed: usize = wallets.items.iter().map(|wallet| wallet.closed_count).sum();
        assert_eq!(closed, wallets.total.closed_count);
    }
}
