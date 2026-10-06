//! Both Overview wire versions share one formatter. V1 keeps its integer fee count; V2 can
//! preserve the other figures when raw fee presence is not yet known for every position.

use binsight_engine::portfolio::views;
use serde::Serialize;
use utoipa::ToSchema;

use crate::contract::{
    ClosedTotals, DecimalString, Figure, Freshness, PercentFigure, SyncState, WalletRef, Window,
};
use crate::error::{ApiError, ErrorCode};
use crate::overview::watch::{UnpricedHolding, WatchItem};

/// The v1 overview; every successful response contains a proved integer fee count.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ToSchema)]
pub(crate) struct Overview {
    #[serde(flatten)]
    pub(crate) fields: OverviewFields,
    /// The open positions together.
    pub(crate) open: OpenSummary,
}

/// The v2 overview retains all other figures when a scoped fee presence is unknown.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ToSchema)]
pub(crate) struct OverviewV2 {
    #[serde(flatten)]
    pub(crate) fields: OverviewFields,
    /// The open positions together.
    pub(crate) open: OpenSummaryV2,
}

/// V1 only emits this response when all raw fee presences are classified.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ToSchema)]
pub(crate) struct OpenSummary {
    #[serde(flatten)]
    pub(crate) fields: OpenSummaryFields,
    /// How many have observed raw fees to claim.
    pub(crate) unclaimed_position_count: usize,
}

/// V2 explicitly carries the absence of a complete raw fee classification.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ToSchema)]
pub(crate) struct OpenSummaryV2 {
    #[serde(flatten)]
    pub(crate) fields: OpenSummaryFields,
    /// How many have observed raw fees to claim; null if any position's presence is unknown.
    #[schema(required = true)]
    pub(crate) unclaimed_position_count: Option<usize>,
}

/// Everything the overview shows.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ToSchema)]
pub(crate) struct OverviewFields {
    /// The wallet it is about; `null` for every wallet.
    pub(crate) wallet: Option<WalletRef>,
    /// How fresh its figures are.
    pub(crate) freshness: Freshness,
    /// Which wallets lag behind the chain or import their history.
    pub(crate) sync: OverviewSync,
    /// The positions closed since local midnight: the same totals as today's recent closes and
    /// History for today.
    pub(crate) today: Today,
    /// The net worth now: `total` is the sum of the four parts.
    pub(crate) net_worth: NetWorth,
    /// The real PnL gained over the period.
    pub(crate) gain: Gain,
    /// What deserves attention, most urgent first.
    pub(crate) watch: Vec<WatchItem>,
}

/// The synchronization of the wallets the overview covers.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ToSchema)]
pub(crate) struct OverviewSync {
    /// The worst state.
    pub(crate) state: SyncState,
    /// The wallets behind the chain.
    pub(crate) lagging: Vec<WalletRef>,
    /// The wallets importing their history.
    pub(crate) importing: Vec<ImportingWallet>,
}

/// A wallet importing its history.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ToSchema)]
pub(crate) struct ImportingWallet {
    /// The wallet.
    pub(crate) wallet: WalletRef,
    /// How far the import is, in percent; null when its total is unknown.
    #[schema(required = true)]
    pub(crate) progress: Option<DecimalString>,
}

/// The positions closed since local midnight.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ToSchema)]
pub(crate) struct Today {
    /// Today's window.
    pub(crate) window: Window,
    /// Their totals; `pnl_pct` is `Σ PnL / Σ invested` of today's closes.
    pub(crate) totals: ClosedTotals,
}

/// The net worth in its parts.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ToSchema)]
pub(crate) struct NetWorth {
    /// idle + lp + unclaimed fees + recoverable rent.
    pub(crate) total: Figure,
    /// Free SOL and priced tokens.
    pub(crate) idle: Figure,
    /// The liquidity in open positions.
    pub(crate) lp: Figure,
    /// The fees the open positions could claim.
    pub(crate) unclaimed_fees: Figure,
    /// The rent closing accounts would give back.
    pub(crate) recoverable_rent: Figure,
    /// The tokens held without a price, left out of the total (which is then `partial`).
    pub(crate) unpriced: Vec<UnpricedHolding>,
}

/// The open positions together.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ToSchema)]
pub(crate) struct OpenSummaryFields {
    /// How many.
    pub(crate) count: usize,
    /// How many are out of range.
    pub(crate) out_of_range_count: usize,
    /// Their open PnL.
    pub(crate) pnl: Figure,
    /// Their PnL as a percentage of their net investment.
    pub(crate) pnl_pct: PercentFigure,
    /// The fees they could claim (the same as the net worth's part).
    pub(crate) unclaimed_fees: Figure,
}

/// The real PnL gained over a period.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ToSchema)]
pub(crate) struct Gain {
    /// The period's window.
    pub(crate) window: Window,
    /// Real PnL now − real PnL at the start (the real PnL series ends on it).
    pub(crate) value: Figure,
    /// The gain as a percentage of the net worth at the start; `unavailable` for `all`.
    pub(crate) pct: PercentFigure,
}

impl From<views::OverviewView> for OverviewFields {
    fn from(view: views::OverviewView) -> Self {
        Self {
            wallet: view.wallet.as_ref().map(WalletRef::from),
            freshness: view.freshness.into(),
            sync: OverviewSync {
                state: view.sync.state.into(),
                lagging: view.sync.lagging.iter().map(WalletRef::from).collect(),
                importing: view
                    .sync
                    .importing
                    .iter()
                    .map(|(wallet, progress)| ImportingWallet {
                        wallet: wallet.into(),
                        progress: progress.map(DecimalString::from),
                    })
                    .collect(),
            },
            today: Today {
                window: (&view.today.window).into(),
                totals: (&view.today.totals).into(),
            },
            net_worth: NetWorth {
                total: (&view.net_worth.total).into(),
                idle: (&view.net_worth.idle).into(),
                lp: (&view.net_worth.lp).into(),
                unclaimed_fees: (&view.net_worth.unclaimed_fees).into(),
                recoverable_rent: (&view.net_worth.recoverable_rent).into(),
                unpriced: view
                    .net_worth
                    .unpriced
                    .iter()
                    .map(UnpricedHolding::from)
                    .collect(),
            },
            gain: Gain {
                window: (&view.gain.window).into(),
                value: (&view.gain.value).into(),
                pct: (&view.gain.pct).into(),
            },
            watch: view.watch.iter().map(WatchItem::from).collect(),
        }
    }
}

impl From<&views::OpenSummary> for OpenSummaryFields {
    fn from(view: &views::OpenSummary) -> Self {
        Self {
            count: view.count,
            out_of_range_count: view.out_of_range_count,
            pnl: (&view.pnl).into(),
            pnl_pct: (&view.pnl_pct).into(),
            unclaimed_fees: (&view.unclaimed_fees).into(),
        }
    }
}

impl From<views::OverviewView> for OverviewV2 {
    fn from(view: views::OverviewView) -> Self {
        let open = OpenSummaryV2 {
            fields: (&view.open).into(),
            unclaimed_position_count: view.open.unclaimed_position_count,
        };
        Self {
            fields: view.into(),
            open,
        }
    }
}

impl TryFrom<views::OverviewView> for Overview {
    type Error = ApiError;

    fn try_from(view: views::OverviewView) -> Result<Self, Self::Error> {
        let count = view.open.unclaimed_position_count.ok_or_else(|| {
            ApiError::new(
                ErrorCode::DataNotReady,
                "the unclaimed fee position count is not known",
            )
        })?;
        let overview = OverviewV2::from(view);
        Ok(Self {
            fields: overview.fields,
            open: OpenSummary {
                fields: overview.open.fields,
                unclaimed_position_count: count,
            },
        })
    }
}
