//! Immutable raw-fee classifications served through the real portfolio query.

use binsight_core::units::{Decimals, Lamports, RawTokenAmount};
use binsight_engine::EngineStatus;
use binsight_engine::portfolio::query::*;
use binsight_engine::portfolio::views::*;
use binsight_engine::portfolio::*;
use binsight_ledger::facts::*;
use binsight_ledger::report::figure::{Figure, Reason};
use binsight_ledger::report::valued::Currency;
use binsight_solana::{Address, Signature};
use jiff::tz::TimeZone;
use jiff::{SignedDuration, Timestamp};
use std::sync::atomic::{AtomicUsize, Ordering};

pub(super) struct FeeOverview {
    snapshot: Snapshot,
    status: InstanceStatus,
    context: ReadContext,
    reads: AtomicUsize,
}

impl FeeOverview {
    pub(super) fn new() -> Self {
        let now = Timestamp::from_second(super::common::START_SECONDS).unwrap();
        let token = |byte, kind| TokenFacts {
            mint: Address::from_bytes([byte; 32]),
            symbol: None,
            name: None,
            decimals: Decimals(6),
            kind,
        };
        let pool = PoolFacts {
            address: Address::from_bytes([3; 32]),
            bin_step: 1_000,
            base: token(1, TokenKind::Usdc),
            quote: token(2, TokenKind::Other),
        };
        // The known raw X fee is already in the selected stablecoin unit; no token price is
        // needed for this source observation. Engine tests separately prove opposite-side floor0.
        let raw_fees = (RawTokenAmount(1), RawTokenAmount(0));
        let mut known = position(4, now);
        known.unclaimed_fees = Figure::Complete(QuoteUnits(1));
        known.unclaimed_fee_presence = Some(raw_fees.0.0 > 0 || raw_fees.1.0 > 0);
        let mut unknown = position(5, now);
        unknown.unclaimed_fee_presence = None;
        unknown.unclaimed_fees = Figure::Partial {
            value: QuoteUnits(0),
            reasons: [Reason::UnpricedLeg {
                position: unknown.id,
            }]
            .into(),
        };
        let facts = SnapshotFacts {
            pools: vec![pool],
            open: vec![known, unknown],
            wallets: [4, 5, 6]
                .into_iter()
                .map(|byte| wallet(byte, now))
                .collect(),
            ..SnapshotFacts::default()
        };
        Self {
            snapshot: Snapshot::new(facts).unwrap(),
            status: InstanceStatus {
                engine: EngineStatus::Running,
                started_at: now,
                chain: ChainTip::default(),
                valuation_interval_seconds: None,
                credit_cycle: BillingCycle {
                    start: now.checked_sub(SignedDuration::from_hours(24)).unwrap(),
                    end: now.checked_add(SignedDuration::from_hours(24)).unwrap(),
                },
                credits_used: 0,
                credits_budget: 100,
            },
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

fn position(byte: u8, now: Timestamp) -> OpenPositionFacts {
    OpenPositionFacts {
        id: PositionId {
            address: Address::from_bytes([byte; 32]),
            opened_by: Signature::from_bytes([byte; 64]),
        },
        wallet: Address::from_bytes([byte; 32]),
        pool: Address::from_bytes([3; 32]),
        strategy: Some(Strategy::Spot),
        opened_at: now,
        invested: QuoteUnits(0),
        withdrawn: QuoteUnits(0),
        claimed_fees: QuoteUnits(0),
        rewards: QuoteUnits(0),
        unpriced_rewards: 0,
        value: Figure::Complete(QuoteUnits(0)),
        unclaimed_fees: Figure::Complete(QuoteUnits(0)),
        unclaimed_fee_presence: Some(false),
        lower_bin_id: 0,
        upper_bin_id: 2,
        active_bin_id: 1,
        bins: vec![],
        range_since: None,
        valued_at: now,
        unpriced_movements: 0,
        unpriced_rebalances: 0,
    }
}

fn wallet(byte: u8, now: Timestamp) -> TrackedWallet {
    let address = Address::from_bytes([byte; 32]);
    TrackedWallet {
        facts: WalletFacts {
            address,
            added_at: now,
            history: HistoryCoverage::Complete,
        },
        label: WalletLabel::short_address(&address),
        color: WalletColor::Wallet1,
        holdings: WalletHoldings {
            wallet: address,
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
    }
}

impl HistoryReads for FeeOverview {
    fn closed_page(&self, _: ClosedQuery, _: ClosedPageRequest) -> Answer<'_, ClosedPage> {
        answered(Err(ReadError::NotReady))
    }
    fn pools(&self, _: PoolQuery) -> Answer<'_, Vec<PoolOption>> {
        answered(Err(ReadError::NotReady))
    }
}
impl InstanceReads for FeeOverview {
    fn sync_report(&self) -> Answer<'_, SyncReport> {
        answered(Err(ReadError::NotReady))
    }
    fn settings(&self) -> Answer<'_, InstanceSettings> {
        answered(Err(ReadError::NotReady))
    }
}
impl WalletReads for FeeOverview {
    fn wallets(&self, _: Currency) -> Answer<'_, WalletsView> {
        answered(Err(ReadError::NotReady))
    }
}
impl PortfolioReads for FeeOverview {
    fn overview(&self, request: OverviewRequest) -> Answer<'_, OverviewView> {
        self.reads.fetch_add(1, Ordering::SeqCst);
        answered(overview(
            &self.snapshot,
            &self.status,
            request,
            &self.context,
        ))
    }
    fn open_positions(&self, _: OpenPositionsRequest) -> Answer<'_, OpenPositionsView> {
        answered(Err(ReadError::NotReady))
    }
    fn recent_closes(&self, _: Scope, _: Currency) -> Answer<'_, RecentClosesView> {
        answered(Err(ReadError::NotReady))
    }
}
impl StatsReads for FeeOverview {
    fn stats_series(&self, _: SeriesRequest) -> Answer<'_, SeriesView> {
        answered(Err(ReadError::NotReady))
    }
}
impl PositionReads for FeeOverview {
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
