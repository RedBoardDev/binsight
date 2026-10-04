//! Positions on the wire: their strategy and outcome, closed-position rows and their totals.

use binsight_engine::portfolio::views;
use binsight_ledger::facts::Strategy as LedgerStrategy;
use binsight_ledger::report::closed::Outcome as LedgerOutcome;
use jiff::Timestamp;
use serde::Serialize;
use utoipa::ToSchema;

use super::figure::{Figure, PercentFigure};
use super::token::PoolRef;
use super::wallet_ref::WalletRef;

/// How a position spreads its liquidity over its bins.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Strategy {
    /// The same amount in every bin.
    Spot,
    /// More liquidity near the active bin.
    Curve,
    /// More liquidity at the edges.
    BidAsk,
}

/// How a closed position ended, read on the sign of its PnL in the pool's quote token.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Outcome {
    /// It gained.
    Win,
    /// It lost.
    Loss,
    /// It ended exactly even.
    Breakeven,
}

/// How a position's PnL was measured.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub(crate) enum PnlMethod {
    /// Through the FIFO cost basis of its tokens (`pnl` is the market PnL).
    Fifo,
    /// At the bin price of each movement (`pnl` is the liquidity PnL).
    Pool,
}

/// One closed position. Its figures are exact on their own, even while a wallet imports.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ToSchema)]
pub(crate) struct ClosedPositionRow {
    /// Its stable id, `<address>-<opening signature>`; permanent links use it.
    pub(crate) id: String,
    /// The position account (it can host several positions over time).
    pub(crate) address: String,
    /// The wallet that owned it.
    pub(crate) wallet: WalletRef,
    /// Its pool.
    pub(crate) pool: PoolRef,
    /// How its liquidity was spread.
    pub(crate) strategy: Strategy,
    /// When it opened.
    pub(crate) opened_at: Timestamp,
    /// When it closed.
    pub(crate) closed_at: Timestamp,
    /// How long it was held, in seconds.
    pub(crate) held_seconds: i64,
    /// What it invested.
    pub(crate) invested: Figure,
    /// What it withdrew.
    pub(crate) withdrawn: Figure,
    /// The fees it claimed.
    pub(crate) fees: Figure,
    /// The fees as a percentage of what it invested.
    pub(crate) fees_pct: PercentFigure,
    /// Its PnL.
    pub(crate) pnl: Figure,
    /// Its PnL as a percentage of what it invested.
    pub(crate) pnl_pct: PercentFigure,
    /// Its liquidity PnL: withdrawn + fees − invested.
    pub(crate) lp_pnl: Figure,
    /// Its FIFO market PnL, when measured that way.
    pub(crate) market_pnl: Option<Figure>,
    /// How its PnL was measured.
    pub(crate) method: PnlMethod,
    /// How it ended.
    pub(crate) outcome: Outcome,
    /// Its PnL per day held (holdings under an hour count as an hour), in percent.
    pub(crate) dpr: PercentFigure,
    /// Whether nothing ever moved: an empty shell, left out of totals.
    pub(crate) is_shell: bool,
}

/// The totals of a set of closed positions (empty shells left out).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ToSchema)]
pub(crate) struct ClosedTotals {
    /// How many.
    pub(crate) count: usize,
    /// How many gained.
    pub(crate) wins: usize,
    /// How many lost.
    pub(crate) losses: usize,
    /// How many ended even.
    pub(crate) breakeven: usize,
    /// `wins / (wins + losses)`, breakeven left out.
    pub(crate) win_rate: PercentFigure,
    /// The sum of their PnL.
    pub(crate) pnl: Figure,
    /// `Σ PnL / Σ invested`.
    pub(crate) pnl_pct: PercentFigure,
    /// The sum of their fees.
    pub(crate) fees: Figure,
    /// The sum invested.
    pub(crate) invested: Figure,
    /// The sum withdrawn.
    pub(crate) withdrawn: Figure,
    /// The mean holding time, in seconds; `null` for an empty set.
    pub(crate) average_held_seconds: Option<i64>,
    /// The median holding time, in seconds; `null` for an empty set.
    pub(crate) median_held_seconds: Option<i64>,
}

impl From<LedgerStrategy> for Strategy {
    fn from(strategy: LedgerStrategy) -> Self {
        match strategy {
            LedgerStrategy::Spot => Self::Spot,
            LedgerStrategy::Curve => Self::Curve,
            LedgerStrategy::BidAsk => Self::BidAsk,
        }
    }
}

impl From<&views::ClosedPositionRow> for ClosedPositionRow {
    fn from(row: &views::ClosedPositionRow) -> Self {
        Self {
            id: row.id.to_string(),
            address: row.id.address.to_string(),
            wallet: (&row.wallet).into(),
            pool: (&row.pool).into(),
            strategy: row.strategy.into(),
            opened_at: row.opened_at,
            closed_at: row.closed_at,
            held_seconds: row.held_seconds,
            invested: (&row.invested).into(),
            withdrawn: (&row.withdrawn).into(),
            fees: (&row.fees).into(),
            fees_pct: (&row.fees_pct).into(),
            pnl: (&row.pnl).into(),
            pnl_pct: (&row.pnl_pct).into(),
            lp_pnl: (&row.lp_pnl).into(),
            market_pnl: row.market_pnl.as_ref().map(Figure::from),
            method: match row.method {
                views::PnlMethodView::Fifo => PnlMethod::Fifo,
                views::PnlMethodView::Pool => PnlMethod::Pool,
            },
            outcome: match row.outcome {
                LedgerOutcome::Win => Outcome::Win,
                LedgerOutcome::Loss => Outcome::Loss,
                LedgerOutcome::Breakeven => Outcome::Breakeven,
            },
            dpr: (&row.dpr).into(),
            is_shell: row.is_shell,
        }
    }
}

impl From<&views::ClosedTotalsView> for ClosedTotals {
    fn from(totals: &views::ClosedTotalsView) -> Self {
        Self {
            count: totals.count,
            wins: totals.wins,
            losses: totals.losses,
            breakeven: totals.breakeven,
            win_rate: (&totals.win_rate).into(),
            pnl: (&totals.pnl).into(),
            pnl_pct: (&totals.pnl_pct).into(),
            fees: (&totals.fees).into(),
            invested: (&totals.invested).into(),
            withdrawn: (&totals.withdrawn).into(),
            average_held_seconds: totals.average_held_seconds,
            median_held_seconds: totals.median_held_seconds,
        }
    }
}
