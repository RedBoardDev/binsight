//! The overview: today's closes, the net worth, the open positions, the gain and what to watch.

use binsight_core::ratio::Percent;
use binsight_core::units::RawTokenAmount;
use binsight_ledger::facts::PositionId;
use binsight_ledger::report::figure::Figure;
use binsight_ledger::report::valued::Money;
use jiff::Timestamp;

use super::closed::ClosedTotalsView;
use super::refs::{PoolRef, TokenRef, WalletRef};
use super::sync::SyncState;
use super::window::{Freshness, WindowView};

/// Everything the overview shows.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OverviewView {
    /// The wallet it is about, or `None` for every wallet.
    pub wallet: Option<WalletRef>,
    /// How fresh its figures are.
    pub freshness: Freshness,
    /// Which wallets lag or import.
    pub sync: OverviewSync,
    /// The positions closed since local midnight.
    pub today: TodayView,
    /// The net worth now, in its parts.
    pub net_worth: NetWorthView,
    /// The open positions together.
    pub open: OpenSummary,
    /// The real PnL gained over the period.
    pub gain: GainView,
    /// What deserves the owner's attention, most urgent first.
    pub watch: Vec<WatchItem>,
}

/// The synchronization of the scope.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OverviewSync {
    /// The worst state.
    pub state: SyncState,
    /// The wallets behind the chain.
    pub lagging: Vec<WalletRef>,
    /// The wallets importing their history, with their progress.
    pub importing: Vec<(WalletRef, Option<Percent>)>,
}

/// Today: the positions closed since local midnight.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TodayView {
    /// Today's window.
    pub window: WindowView,
    /// Their totals (the same as the recent closes of today and History for today).
    pub totals: ClosedTotalsView,
}

/// The net worth and its parts.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NetWorthView {
    /// idle + lp + unclaimed fees + recoverable rent.
    pub total: Figure<Money>,
    /// Free SOL and priced tokens.
    pub idle: Figure<Money>,
    /// The liquidity in open positions.
    pub lp: Figure<Money>,
    /// The fees the open positions could claim.
    pub unclaimed_fees: Figure<Money>,
    /// The rent closing accounts would give back.
    pub recoverable_rent: Figure<Money>,
    /// The tokens held without a price (left out of the total).
    pub unpriced: Vec<UnpricedHolding>,
}

/// A token held without a price.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UnpricedHolding {
    /// Who holds it.
    pub wallet: WalletRef,
    /// The token.
    pub token: TokenRef,
    /// How much, in raw units.
    pub amount: RawTokenAmount,
}

/// The open positions together.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpenSummary {
    /// How many.
    pub count: usize,
    /// How many are out of range.
    pub out_of_range_count: usize,
    /// Their open PnL.
    pub pnl: Figure<Money>,
    /// Their PnL as a percentage of their net investment.
    pub pnl_pct: Figure<Percent>,
    /// The fees they could claim.
    pub unclaimed_fees: Figure<Money>,
    /// How many have observed raw fees to claim; unknown if any position cannot be classified.
    pub unclaimed_position_count: Option<usize>,
}

/// The real PnL gained over a period.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GainView {
    /// The period's window.
    pub window: WindowView,
    /// real PnL now − real PnL at the start.
    pub value: Figure<Money>,
    /// The gain as a percentage of the net worth at the start.
    pub pct: Figure<Percent>,
}

/// Something that deserves the owner's attention.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WatchItem {
    /// A position is out of its range.
    OutOfRange {
        /// The position.
        position: PositionId,
        /// Its pool (boxed: it is much larger than the other items).
        pool: Box<PoolRef>,
        /// Its wallet.
        wallet: WalletRef,
        /// Whether the price is above the range.
        is_above: bool,
        /// Since when.
        since: Option<Timestamp>,
    },
    /// A wallet holds a token without a price.
    UnpricedToken(UnpricedHolding),
    /// A wallet is importing its history.
    Importing {
        /// The wallet.
        wallet: WalletRef,
        /// How far it is, when its total is known.
        progress: Option<Percent>,
        /// How long it should still take, in seconds.
        eta_seconds: Option<u64>,
    },
    /// A wallet is behind the chain.
    Lagging {
        /// The wallet.
        wallet: WalletRef,
        /// By how many seconds.
        lag_seconds: Option<u64>,
    },
    /// Observed or projected cycle spending exceeds its budget.
    CreditsOverBudget {
        /// Credits already admitted by the source.
        used: u64,
        /// Expected cycle spending; unknown if no second has elapsed.
        projected: Option<u64>,
        /// The budget.
        budget: u64,
    },
}
