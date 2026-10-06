//! One counted portfolio read delegates to the actual position query on an immutable snapshot.

#[path = "facts.rs"]
mod facts;

use binsight_engine::portfolio::query::*;
use binsight_engine::portfolio::views::*;
use binsight_engine::portfolio::*;
use binsight_ledger::facts::PositionId;
use binsight_ledger::report::valued::Currency;
use binsight_solana::Address;
use jiff::{Timestamp, tz::TimeZone};
use std::sync::atomic::{AtomicUsize, Ordering};

pub(super) use facts::id;

pub(super) struct NativePositions {
    snapshot: Snapshot,
    context: ReadContext,
    reads: AtomicUsize,
}

impl NativePositions {
    pub(super) fn new() -> Self {
        let now = Timestamp::from_second(super::common::START_SECONDS).unwrap();
        Self {
            snapshot: Snapshot::new(facts::facts(now)).unwrap(),
            context: ReadContext {
                now,
                timezone: TimeZone::UTC,
            },
            reads: AtomicUsize::new(0),
        }
    }

    pub(super) fn reads(&self) -> usize {
        self.reads.load(Ordering::SeqCst)
    }
}

impl PositionReads for NativePositions {
    fn position(&self, request: PositionRequest) -> Answer<'_, PositionDetailView> {
        self.reads.fetch_add(1, Ordering::SeqCst);
        answered(position(&self.snapshot, request, &self.context))
    }
    fn position_events(&self, _: EventPageRequest) -> Answer<'_, EventPage> {
        answered(Err(ReadError::NotReady))
    }
    fn position_candles(&self, _: PositionId, _: IntervalChoice) -> Answer<'_, CandlesView> {
        answered(Err(ReadError::NotReady))
    }
    fn token_logo(&self, _: Address) -> Answer<'_, TokenLogoImage> {
        answered(Err(ReadError::NotReady))
    }
}
impl HistoryReads for NativePositions {
    fn closed_page(&self, _: ClosedQuery, _: ClosedPageRequest) -> Answer<'_, ClosedPage> {
        answered(Err(ReadError::NotReady))
    }
    fn pools(&self, _: PoolQuery) -> Answer<'_, Vec<PoolOption>> {
        answered(Err(ReadError::NotReady))
    }
}
impl InstanceReads for NativePositions {
    fn sync_report(&self) -> Answer<'_, SyncReport> {
        answered(Err(ReadError::NotReady))
    }
    fn settings(&self) -> Answer<'_, InstanceSettings> {
        answered(Err(ReadError::NotReady))
    }
}
impl WalletReads for NativePositions {
    fn wallets(&self, _: Currency) -> Answer<'_, WalletsView> {
        answered(Err(ReadError::NotReady))
    }
}
impl PortfolioReads for NativePositions {
    fn overview(&self, _: OverviewRequest) -> Answer<'_, OverviewView> {
        answered(Err(ReadError::NotReady))
    }
    fn open_positions(&self, _: OpenPositionsRequest) -> Answer<'_, OpenPositionsView> {
        answered(Err(ReadError::NotReady))
    }
    fn recent_closes(&self, _: Scope, _: Currency) -> Answer<'_, RecentClosesView> {
        answered(Err(ReadError::NotReady))
    }
}
impl StatsReads for NativePositions {
    fn stats_series(&self, _: SeriesRequest) -> Answer<'_, SeriesView> {
        answered(Err(ReadError::NotReady))
    }
}
