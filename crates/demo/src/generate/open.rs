//! The open positions of a wallet, with their liquidity bin by bin.
//!
//! Each position sits in its pool at the current active bin of the price path. Its value is spread
//! over its range by its strategy (even, peaked or at the edges); bins above the active one hold
//! base token, bins below hold quote token, the active one holds both. The value the position
//! reports is recomputed from those bins at the active price, so the two always agree to the unit.
//! Out-of-range positions are placed just beyond their range.

use binsight_core::units::RawTokenAmount;
use binsight_dlmm::math::{Q64x64, div_q64, mul_shr_64};
use binsight_ledger::facts::{
    BinLiquidity, OpenPositionFacts, PositionId, QuoteUnits, SolUsdRates, Strategy,
};
use binsight_solana::Address;
use jiff::Timestamp;

use super::Timeline;
use super::closed::{in_quote, share};
use super::market::{CatalogPool, PricePath, bin_price};
use crate::addresses::{address, signature};
use crate::error::DemoError;
use crate::random::Stream;
use crate::scenario::{OpenSpec, Placement};

/// The youngest and oldest open positions, in seconds (ten minutes to six days).
const AGE_SECONDS: (i64, i64) = (600, 518_400);

/// The narrowest and widest ranges, in bins.
const WIDTH_BINS: (i64, i64) = (20, 69);

/// The smallest and largest amounts invested, in lamports.
const INVESTED_LAMPORTS: (i64, i64) = (1_000_000_000, 12_000_000_000);

/// How far out of its range an out-of-range position is, in basis points of price.
const OUTSIDE_BPS: i64 = 200;

/// The fees an open position earns a day, in basis points of the amount invested.
const DAILY_FEES_BPS: (i64, i64) = (5, 40);

/// Seconds in a day.
const SECONDS_PER_DAY: i128 = 86_400;

/// The open position `spec` of a wallet.
pub(crate) fn open_position(
    seed: u64,
    (wallet, label, index): (Address, &str, usize),
    spec: &OpenSpec,
    (pool, path): (&CatalogPool, &PricePath),
    timeline: &Timeline,
    rates: &SolUsdRates,
) -> Result<OpenPositionFacts, DemoError> {
    let name = format!("open:{label}:{index}");
    let mut stream = Stream::of(seed, &name);
    let age = stream.between(AGE_SECONDS.0, AGE_SECONDS.1);
    let opened_at = at(timeline.anchor.as_second().saturating_sub(age))?;
    let active = path.bin_at(timeline.anchor);
    let width = stream.between(WIDTH_BINS.0, WIDTH_BINS.1);
    let (lower, upper) = range(
        &mut stream,
        spec.placement,
        active,
        width,
        pool.facts.bin_step,
    );
    let asset = pool.facts.quote_asset().ok_or(DemoError::UnknownPool)?;
    let invested = in_quote(
        i128::from(stream.log_uniform(INVESTED_LAMPORTS.0, INVESTED_LAMPORTS.1)),
        asset,
        rates,
        timeline.anchor,
    )?;
    let move_bps = match spec.placement {
        Placement::Inside => stream.between(-300, 200),
        Placement::Above => stream.between(100, 500),
        Placement::Below => stream.between(-800, -300),
    };
    let target = invested.saturating_add(share(invested, move_bps)?);
    let strategy = [Strategy::Spot, Strategy::Curve, Strategy::BidAsk]
        .get(usize::try_from(stream.below(3)).unwrap_or(0))
        .copied()
        .unwrap_or(Strategy::Spot);
    let active_price = bin_price(active, pool.facts.bin_step)?;
    let (bins, value) = spread_liquidity(target, (lower, upper, active), strategy, active_price)?;
    let daily_fees = share(invested, stream.between(DAILY_FEES_BPS.0, DAILY_FEES_BPS.1))?;
    let unclaimed = daily_fees.saturating_mul(i128::from(age)) / SECONDS_PER_DAY;
    let claimed = if i128::from(age) > SECONDS_PER_DAY {
        share(invested, stream.between(5, 50))?
    } else {
        0
    };
    let since = match spec.placement {
        Placement::Inside => None,
        Placement::Above | Placement::Below => Some(at(timeline
            .anchor
            .as_second()
            .saturating_sub(stream.between(1_200, age.min(21_600))))?),
    };
    Ok(OpenPositionFacts {
        id: PositionId {
            address: address(&format!("position:{name}")),
            opened_by: signature(&name),
        },
        wallet,
        pool: pool.facts.address,
        strategy,
        opened_at,
        invested: QuoteUnits(invested),
        withdrawn: QuoteUnits(0),
        claimed_fees: QuoteUnits(claimed),
        value: QuoteUnits(value),
        unclaimed_fees: QuoteUnits(unclaimed),
        lower_bin_id: lower,
        upper_bin_id: upper,
        active_bin_id: active,
        bins,
        range_since: since,
        valued_at: timeline.anchor,
        unpriced_movements: 0,
    })
}

/// The lowest and highest bins of a range of `width` bins placed against the `active` bin.
fn range(
    stream: &mut Stream,
    placement: Placement,
    active: i32,
    width: i64,
    bin_step: u16,
) -> (i32, i32) {
    let width = i32::try_from(width).unwrap_or(20);
    let outside = OUTSIDE_BPS
        .checked_div(i64::from(bin_step))
        .unwrap_or(1)
        .max(1);
    let outside = i32::try_from(outside).unwrap_or(1);
    let lower = match placement {
        Placement::Inside => {
            let below_active = i32::try_from(
                stream.between(i64::from(width) / 4, i64::from(width).saturating_mul(3) / 4),
            )
            .unwrap_or(0);
            active.saturating_sub(below_active)
        }
        Placement::Above => active
            .saturating_sub(outside)
            .saturating_sub(width)
            .saturating_add(1),
        Placement::Below => active.saturating_add(outside),
    };
    (lower, lower.saturating_add(width).saturating_sub(1))
}

/// Spreads `value` (quote units) over the bins of `(lower, upper, active)` by `strategy`; returns
/// the bins and their exact value at the active price.
fn spread_liquidity(
    value: i128,
    (lower, upper, active): (i32, i32, i32),
    strategy: Strategy,
    price: Q64x64,
) -> Result<(Vec<BinLiquidity>, i128), DemoError> {
    let center = lower.saturating_add(upper) / 2;
    let weights: Vec<(i32, u64)> = (lower..=upper)
        .map(|bin| {
            let distance = u64::from(bin.abs_diff(center));
            let half = u64::from(upper.abs_diff(lower) / 2);
            let weight = match strategy {
                Strategy::Spot => 10,
                Strategy::Curve => half.saturating_sub(distance).saturating_add(1),
                Strategy::BidAsk => distance.saturating_add(1),
            };
            (bin, weight)
        })
        .collect();
    let total_weight: u64 = weights.iter().map(|(_, weight)| *weight).sum();
    let value = u64::try_from(value.max(0)).map_err(|_| DemoError::OutOfRange)?;
    let mut bins = Vec::with_capacity(weights.len());
    let mut exact: u128 = 0;
    for (bin_id, weight) in weights {
        let part = u64::try_from(
            u128::from(value)
                .saturating_mul(u128::from(weight))
                .checked_div(u128::from(total_weight))
                .unwrap_or(0),
        )
        .unwrap_or(0);
        let (base, quote) = match bin_id.cmp(&active) {
            std::cmp::Ordering::Less => (0, u128::from(part)),
            std::cmp::Ordering::Greater => (div_q64(part, price).unwrap_or(0), 0),
            std::cmp::Ordering::Equal => (
                div_q64(part / 2, price).unwrap_or(0),
                u128::from(part.saturating_sub(part / 2)),
            ),
        };
        exact = exact
            .saturating_add(mul_shr_64(base, price).ok_or(DemoError::OutOfRange)?)
            .saturating_add(quote);
        bins.push(BinLiquidity {
            bin_id,
            base: RawTokenAmount(base),
            quote: RawTokenAmount(quote),
        });
    }
    Ok((
        bins,
        i128::try_from(exact).map_err(|_| DemoError::OutOfRange)?,
    ))
}

/// The instant `second` seconds after the Unix epoch.
fn at(second: i64) -> Result<Timestamp, DemoError> {
    Timestamp::from_second(second).map_err(|_| DemoError::OutOfRange)
}
