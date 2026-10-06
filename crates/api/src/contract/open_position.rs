//! One open position on the wire: its range, its bin chart and its figures.

use binsight_core::decimal::format_units;
use binsight_core::units::Decimals;
use binsight_engine::portfolio::views;
use binsight_ledger::report::open::{Composition as LedgerComposition, RangeStatus};
use jiff::Timestamp;
use serde::Serialize;
use utoipa::ToSchema;

use crate::contract::{DecimalString, Figure, PercentFigure, PoolRef, Price, Strategy, WalletRef};

/// One open position.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ToSchema)]
pub(crate) struct OpenPositionRow {
    /// Its stable id, `<address>-<opening signature>`.
    pub(crate) id: String,
    /// The position account.
    pub(crate) address: String,
    /// The wallet that owns it.
    pub(crate) wallet: WalletRef,
    /// Its pool.
    pub(crate) pool: PoolRef,
    /// Its proven strategy; `null` for arbitrary weights or mixed strategies.
    pub(crate) strategy: Option<Strategy>,
    /// When it opened (clients compute its age).
    pub(crate) opened_at: Timestamp,
    /// The current price (the active bin); `null` when the pool's quote cannot be valued.
    pub(crate) price: Option<Price>,
    /// The price of the lowest bin of the range.
    pub(crate) lower: Option<Price>,
    /// The price of the highest bin of the range.
    pub(crate) upper: Option<Price>,
    /// Where the price stands against the range.
    pub(crate) range: RangeInfo,
    /// Its liquidity, bin by bin.
    pub(crate) bins: BinChart,
    /// The value of its liquidity.
    pub(crate) value: Figure,
    /// What it invested.
    pub(crate) invested: Figure,
    /// What it withdrew.
    pub(crate) withdrawn: Figure,
    /// invested − withdrawn.
    pub(crate) net_invested: Figure,
    /// The fees it claimed.
    pub(crate) claimed_fees: Figure,
    /// Farming rewards, separately from swap fees.
    pub(crate) rewards: Figure,
    /// The fees it could claim.
    pub(crate) unclaimed_fees: Figure,
    /// claimed + unclaimed fees.
    pub(crate) fees: Figure,
    /// withdrawn + claimed fees + rewards + value + unclaimed fees − invested.
    pub(crate) pnl: Figure,
    /// Its PnL as a percentage of what it invested.
    pub(crate) pnl_pct: PercentFigure,
    /// Its PnL per day open (under an hour counts as an hour), in percent.
    pub(crate) dpr: PercentFigure,
    /// Its PnL per year open, in percent; `null` before a full day.
    pub(crate) apr: Option<PercentFigure>,
    /// Its value as a share of its wallet's net worth.
    pub(crate) share_of_net_worth: PercentFigure,
    /// Always `pool`: an open position is marked at its bins.
    pub(crate) method: OpenMethod,
}

/// How an open position's PnL is measured: at its bins.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub(crate) enum OpenMethod {
    /// At the bin price.
    Pool,
}

/// Where the price stands against a range.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ToSchema)]
pub(crate) struct RangeInfo {
    /// Inside, above or below.
    pub(crate) status: RangeStatusWire,
    /// Since when it is on that side; `null` when it never moved since the opening.
    pub(crate) since: Option<Timestamp>,
    /// How far the price can fall to the bottom of the range, in percent (negative outside).
    pub(crate) margin_down: PercentFigure,
    /// How far the price can rise to the top of the range, in percent (negative outside).
    pub(crate) margin_up: PercentFigure,
    /// What the position holds (above the range: only quote; below: only base).
    pub(crate) composition: Composition,
}

/// Where the price stands against a range.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
#[schema(as = RangeStatus)]
pub(crate) enum RangeStatusWire {
    /// Inside: the position earns fees.
    InRange,
    /// Above the range.
    Above,
    /// Below the range.
    Below,
}

/// What a position holds.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Composition {
    /// Both tokens.
    Mixed,
    /// Only the base token.
    AllBase,
    /// Only the quote token.
    AllQuote,
}

/// A position's liquidity bin by bin (at most 70 bars; bins are grouped beyond).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ToSchema)]
pub(crate) struct BinChart {
    /// The pool's active bin.
    pub(crate) active_bin_id: i32,
    /// The lowest bin of the range.
    pub(crate) lower_bin_id: i32,
    /// The highest bin of the range.
    pub(crate) upper_bin_id: i32,
    /// One bar per bin (or group of bins), lowest first.
    pub(crate) bars: Vec<BinBar>,
}

/// One bar of a bin chart.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ToSchema)]
pub(crate) struct BinBar {
    /// Its (first) bin.
    pub(crate) bin_id: i32,
    /// The price of that bin.
    pub(crate) price: Option<Price>,
    /// Its base token, in whole tokens.
    pub(crate) base: DecimalString,
    /// Its quote token, in whole tokens.
    pub(crate) quote: DecimalString,
    /// Relative depth at each bin’s own price, from `0` to `1` of the largest bar.
    /// Supported pools use the selected native token; unsupported pools retain descriptive
    /// physical Y depth, which never enters a financial figure.
    pub(crate) height: DecimalString,
}

impl From<&views::OpenPositionRow> for OpenPositionRow {
    fn from(row: &views::OpenPositionRow) -> Self {
        Self {
            id: row.id.to_string(),
            address: row.id.address.to_string(),
            wallet: (&row.wallet).into(),
            pool: (&row.pool).into(),
            strategy: row.strategy.map(Into::into),
            opened_at: row.opened_at,
            price: row.price.map(Price::from),
            lower: row.lower.map(Price::from),
            upper: row.upper.map(Price::from),
            range: RangeInfo {
                status: match row.range.status {
                    RangeStatus::InRange => RangeStatusWire::InRange,
                    RangeStatus::Above => RangeStatusWire::Above,
                    RangeStatus::Below => RangeStatusWire::Below,
                },
                since: row.range.since,
                margin_down: (&row.range.margin_down).into(),
                margin_up: (&row.range.margin_up).into(),
                composition: match row.range.composition {
                    LedgerComposition::Mixed => Composition::Mixed,
                    LedgerComposition::AllBase => Composition::AllBase,
                    LedgerComposition::AllQuote => Composition::AllQuote,
                },
            },
            bins: bin_chart(&row.bins, row.pool.base.decimals, row.pool.quote.decimals),
            value: (&row.value).into(),
            invested: (&row.invested).into(),
            withdrawn: (&row.withdrawn).into(),
            net_invested: (&row.net_invested).into(),
            claimed_fees: (&row.claimed_fees).into(),
            rewards: (&row.rewards).into(),
            unclaimed_fees: (&row.unclaimed_fees).into(),
            fees: (&row.fees).into(),
            pnl: (&row.pnl).into(),
            pnl_pct: (&row.pnl_pct).into(),
            dpr: (&row.dpr).into(),
            apr: row.apr.as_ref().map(PercentFigure::from),
            share_of_net_worth: (&row.share_of_net_worth).into(),
            method: OpenMethod::Pool,
        }
    }
}

/// The wire chart, amounts in whole tokens.
fn bin_chart(chart: &views::BinChart, base: Decimals, quote: Decimals) -> BinChart {
    BinChart {
        active_bin_id: chart.active_bin_id,
        lower_bin_id: chart.lower_bin_id,
        upper_bin_id: chart.upper_bin_id,
        bars: chart
            .bars
            .iter()
            .map(|bar| BinBar {
                bin_id: bar.bin_id,
                price: bar.price.map(Price::from),
                base: DecimalString::from_canonical(format_units(bar.base, base)),
                quote: DecimalString::from_canonical(format_units(bar.quote, quote)),
                height: DecimalString::from_canonical(bar.height.to_decimal_string()),
            })
            .collect(),
    }
}
