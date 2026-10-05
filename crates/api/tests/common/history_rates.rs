//! Two immutable snapshots differing only in conversion source or read time zone.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::atomic::{AtomicUsize, Ordering};

use binsight_core::money::SolUsdRate;
use binsight_core::units::{Decimals, Lamports};
use binsight_engine::portfolio::query::*;
use binsight_engine::portfolio::views::*;
use binsight_engine::portfolio::*;
use binsight_ledger::facts::*;
use binsight_ledger::report::valued::Currency;
use binsight_solana::{Address, Signature};
use jiff::Timestamp;
use jiff::tz::TimeZone;

pub(crate) struct ChangingHistory {
    snapshots: [Snapshot; 2],
    zones: [TimeZone; 2],
    current: AtomicUsize,
    now: Timestamp,
}

impl ChangingHistory {
    pub(crate) fn new(rate: u64, final_rate: bool, zones: [&str; 2]) -> Self {
        let now = Timestamp::from_second(super::START_SECONDS).unwrap();
        let day = now.to_zoned(TimeZone::UTC).date();
        let mut first = facts(now);
        first.rates.provisional = Some((day, SolUsdRate::new(200_000_000).unwrap()));
        let mut second = first.clone();
        if final_rate {
            second.rates.provisional = None;
            second.rates.daily = BTreeMap::from([(day, SolUsdRate::new(rate).unwrap())]);
        } else {
            second.rates.provisional = Some((day, SolUsdRate::new(rate).unwrap()));
        }
        Self {
            snapshots: [
                Snapshot::new(first).unwrap(),
                Snapshot::new(second).unwrap(),
            ],
            zones: zones.map(|zone| TimeZone::get(zone).unwrap()),
            current: AtomicUsize::new(0),
            now,
        }
    }

    pub(crate) fn switch(&self, current: usize) {
        self.current.store(current, Ordering::SeqCst);
    }

    pub(crate) fn page(&self, query: &ClosedQuery, request: ClosedPageRequest) -> ClosedPage {
        let index = self.current.load(Ordering::SeqCst);
        closed_page(
            self.snapshots.get(index).unwrap(),
            query,
            request,
            &ReadContext {
                now: self.now,
                timezone: self.zones.get(index).unwrap().clone(),
            },
        )
        .unwrap()
    }
}

pub(crate) fn query() -> ClosedQuery {
    ClosedQuery {
        scope: Scope::All,
        day: None,
        search: None,
        outcomes: BTreeSet::new(),
        strategies: BTreeSet::new(),
        pools: BTreeSet::new(),
        sort: ClosedSort::Pnl,
        order: SortOrder::Descending,
        currency: Currency::Usd,
    }
}

fn facts(now: Timestamp) -> SnapshotFacts {
    let wallet = Address::from_bytes([7; 32]);
    let token = |byte, kind, decimals| TokenFacts {
        mint: Address::from_bytes([byte; 32]),
        symbol: None,
        name: None,
        kind,
        decimals,
    };
    let pool = |byte, quote| PoolFacts {
        address: Address::from_bytes([byte; 32]),
        bin_step: 80,
        base: token(8, TokenKind::Other, Decimals(6)),
        quote,
    };
    let pools = vec![
        pool(3, token(5, TokenKind::Sol, Decimals::SOL)),
        pool(4, token(6, TokenKind::Usdc, Decimals(6))),
    ];
    let closed = [
        (1, 3, 1_000_000_000_i128),
        (2, 3, 500_000_000),
        (3, 4, 300_000_000),
        (4, 4, 250_000_000),
    ]
    .into_iter()
    .map(|(index, pool, pnl)| ClosedPositionFacts {
        id: PositionId {
            address: wallet,
            opened_by: Signature::from_bytes([index; 64]),
        },
        wallet,
        pool: Address::from_bytes([pool; 32]),
        strategy: Some(Strategy::Spot),
        opened_at: Timestamp::UNIX_EPOCH,
        closed_at: now,
        invested: QuoteUnits(1),
        withdrawn: QuoteUnits(pnl.checked_add(1).unwrap()),
        claimed_fees: QuoteUnits(0),
        rewards: QuoteUnits(0),
        method: PnlMethod::Pool,
        unpriced_rewards: 0,
        unpriced_movements: 0,
        unpriced_rebalances: 0,
    })
    .collect();
    SnapshotFacts {
        pools,
        closed,
        wallets: vec![TrackedWallet {
            facts: WalletFacts {
                address: wallet,
                added_at: Timestamp::UNIX_EPOCH,
                history: HistoryCoverage::Complete,
            },
            label: WalletLabel::short_address(&wallet),
            color: WalletColor::Wallet1,
            holdings: WalletHoldings {
                wallet,
                idle: Lamports(0),
                recoverable_rent: Lamports(0),
                unpriced: vec![],
                observed_at: now,
            },
            sync: WalletSync {
                state: SyncState::Live,
                lag_seconds: None,
                last_tx_at: None,
                indexed_tx: 0,
                import: None,
            },
        }],
        ..SnapshotFacts::default()
    }
}

impl HistoryReads for ChangingHistory {
    fn closed_page(&self, query: ClosedQuery, page: ClosedPageRequest) -> Answer<'_, ClosedPage> {
        answered(Ok(self.page(&query, page)))
    }
    fn pools(&self, _: PoolQuery) -> Answer<'_, Vec<PoolOption>> {
        answered(Err(ReadError::NotReady))
    }
}
impl InstanceReads for ChangingHistory {
    fn sync_report(&self) -> Answer<'_, SyncReport> {
        answered(Err(ReadError::NotReady))
    }
    fn settings(&self) -> Answer<'_, InstanceSettings> {
        answered(Err(ReadError::NotReady))
    }
}
impl WalletReads for ChangingHistory {
    fn wallets(&self, _: Currency) -> Answer<'_, WalletsView> {
        answered(Err(ReadError::NotReady))
    }
}
impl PortfolioReads for ChangingHistory {
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
impl StatsReads for ChangingHistory {
    fn stats_series(&self, _: SeriesRequest) -> Answer<'_, SeriesView> {
        answered(Err(ReadError::NotReady))
    }
}
impl PositionReads for ChangingHistory {
    fn position(&self, _: PositionRequest) -> Answer<'_, PositionDetailView> {
        answered(Err(ReadError::NotReady))
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
