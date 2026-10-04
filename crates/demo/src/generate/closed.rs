//! The closed positions of a wallet: when they closed, where, how much and how they ended.
//!
//! Closes spread over the wallet's life, more and more frequent towards today, plus a fixed number
//! today and yesterday (the overview always has something to show). Sizes are log-uniform,
//! holding times heavy-tailed, about 60 % are wins. A few are empty shells, a few have a movement
//! without a bin price, and most SOL-quoted ones carry a FIFO market PnL.

use binsight_core::money::SignedLamports;
use binsight_ledger::facts::{
    ClosedPositionFacts, PnlMethod, PositionId, QuoteAsset, QuoteUnits, SolUsdRates, Strategy,
};
use binsight_solana::Address;
use jiff::{SignedDuration, Timestamp};

use super::Timeline;
use super::catalog::CatalogPool;
use crate::addresses::{address, signature};
use crate::error::DemoError;
use crate::random::Stream;
use crate::scenario::WalletProfile;

/// The shortest and longest holding times, in seconds (ten minutes to nine days).
const HOLD_SECONDS: (i64, i64) = (600, 777_600);

/// The smallest and largest amounts invested in a position, in lamports.
const INVESTED_LAMPORTS: (i64, i64) = (500_000_000, 15_000_000_000);

/// The range of a winning, then a losing PnL, in basis points of the amount invested.
const WIN_BPS: (i64, i64) = (1, 600);
const LOSS_BPS: (i64, i64) = (-500, -1);

/// A forced loss is clear enough that a FIFO adjustment cannot turn it into a win.
const FORCED_LOSS_BPS: (i64, i64) = (-800, -200);

/// The range of the fees earned, in basis points of the amount invested.
const FEES_BPS: (i64, i64) = (10, 200);

/// The range of the FIFO adjustment, in basis points of the amount invested.
const FIFO_ADJUSTMENT_BPS: (i64, i64) = (-100, 50);

/// One in basis points.
const BASIS_POINTS: i128 = 10_000;

/// Who closes the positions and where.
pub(crate) struct ClosedPlan<'a> {
    /// The wallet.
    pub(crate) profile: &'a WalletProfile,
    /// Its address.
    pub(crate) wallet: Address,
    /// When it first did anything.
    pub(crate) first_activity: Timestamp,
    /// Its busy pools, with their weights.
    pub(crate) pools: Vec<(&'a CatalogPool, u64)>,
    /// The long-tail pools of its closes, one entry per close.
    pub(crate) long_tail: Vec<&'a CatalogPool>,
}

/// What a generated position is meant to look like.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Shape {
    /// An ordinary position.
    Ordinary,
    /// A clear loss (today's first close of a wallet).
    Loss,
    /// An empty shell: nothing ever moved.
    Shell,
}

/// The closed positions of the wallet of `plan`.
pub(crate) fn closed_positions(
    seed: u64,
    plan: &ClosedPlan<'_>,
    timeline: &Timeline,
    rates: &SolUsdRates,
) -> Result<Vec<ClosedPositionFacts>, DemoError> {
    let instants = close_instants(seed, plan, timeline);
    let mut positions = Vec::with_capacity(instants.len());
    for (n, closed_at) in instants.into_iter().enumerate() {
        let label = format!("closed:{}:{n}", plan.profile.label);
        let mut stream = Stream::of(seed, &label);
        let recent = plan
            .profile
            .closed_today
            .saturating_add(plan.profile.closed_yesterday);
        let tail_index = n.checked_sub(recent);
        let pool = match tail_index.and_then(|index| plan.long_tail.get(index)) {
            Some(pool) => *pool,
            None => pick_pool(&mut stream, &plan.pools)?,
        };
        let shape = shape_of(plan.profile, n, recent);
        positions.push(position(
            &mut stream,
            &label,
            plan,
            pool,
            closed_at,
            shape,
            rates,
        )?);
    }
    if plan.profile.recreates_an_address {
        recreate_one_address(&mut positions);
    }
    Ok(positions)
}

/// The closing instant of every position: today's and yesterday's first (evenly spread), then the
/// older ones, more frequent towards today.
fn close_instants(seed: u64, plan: &ClosedPlan<'_>, timeline: &Timeline) -> Vec<Timestamp> {
    let profile = plan.profile;
    let mut instants = spread(timeline.today, timeline.anchor, profile.closed_today);
    instants.extend(spread(
        timeline.yesterday,
        timeline.today,
        profile.closed_yesterday,
    ));
    let older = profile
        .closed_count
        .saturating_sub(profile.closed_today)
        .saturating_sub(profile.closed_yesterday);
    let mut stream = Stream::of(seed, &format!("closes:{}", profile.label));
    let earliest = plan.first_activity.as_second().saturating_add(7_200);
    let latest = timeline.yesterday.as_second().saturating_sub(1);
    for _ in 0..older {
        let second = stream.rising(earliest, latest);
        instants.push(Timestamp::from_second(second).unwrap_or(timeline.yesterday));
    }
    instants
}

/// `count` instants evenly spread inside `[start, end)`, centred in their slices.
fn spread(start: Timestamp, end: Timestamp, count: usize) -> Vec<Timestamp> {
    let span = end.duration_since(start).as_secs();
    let slices = i64::try_from(count).unwrap_or(1).max(1);
    (0..slices)
        .take(count)
        .filter_map(|index| {
            let offset = span
                .saturating_mul(index.saturating_mul(2).saturating_add(1))
                .checked_div(slices.saturating_mul(2))
                .unwrap_or(0);
            start.checked_add(SignedDuration::from_secs(offset)).ok()
        })
        .collect()
}

/// What the `n`th position of a wallet looks like (the first `recent` ones closed today or
/// yesterday).
fn shape_of(profile: &WalletProfile, n: usize, recent: usize) -> Shape {
    if n == 0 && profile.closed_today >= 1 && profile.loses_first_today {
        return Shape::Loss;
    }
    let is_shell = profile
        .shell_every
        .is_some_and(|every| n >= recent && n.checked_rem(every) == Some(every / 2));
    if is_shell {
        Shape::Shell
    } else {
        Shape::Ordinary
    }
}

/// Picks a busy pool by weight.
fn pick_pool<'a>(
    stream: &mut Stream,
    pools: &[(&'a CatalogPool, u64)],
) -> Result<&'a CatalogPool, DemoError> {
    let total: u64 = pools.iter().map(|(_, weight)| *weight).sum();
    let mut drawn = stream.below(total);
    for (pool, weight) in pools {
        if drawn < *weight {
            return Ok(pool);
        }
        drawn = drawn.saturating_sub(*weight);
    }
    pools
        .first()
        .map(|(pool, _)| *pool)
        .ok_or(DemoError::UnknownPool)
}

/// One closed position.
fn position(
    stream: &mut Stream,
    label: &str,
    plan: &ClosedPlan<'_>,
    pool: &CatalogPool,
    closed_at: Timestamp,
    shape: Shape,
    rates: &SolUsdRates,
) -> Result<ClosedPositionFacts, DemoError> {
    let hold = stream.log_uniform(HOLD_SECONDS.0, HOLD_SECONDS.1);
    let earliest_open = plan.first_activity.as_second().saturating_add(60);
    let opened = closed_at
        .as_second()
        .saturating_sub(hold)
        .max(earliest_open);
    let asset = pool.facts.quote_asset().ok_or(DemoError::UnknownPool)?;
    let invested = in_quote(
        i128::from(stream.log_uniform(INVESTED_LAMPORTS.0, INVESTED_LAMPORTS.1)),
        asset,
        rates,
        closed_at,
    )?;
    let pnl_bps = match (shape, stream.below(100)) {
        (Shape::Loss, _) => stream.between(FORCED_LOSS_BPS.0, FORCED_LOSS_BPS.1),
        (_, 0..60) => stream.between(WIN_BPS.0, WIN_BPS.1),
        (_, 60..97) => stream.between(LOSS_BPS.0, LOSS_BPS.1),
        _ => 0,
    };
    let fees = share(invested, stream.between(FEES_BPS.0, FEES_BPS.1))?;
    let lp_pnl = share(invested, pnl_bps)?;
    let is_fifo = asset == QuoteAsset::Sol && pnl_bps != 0 && stream.chance(70);
    let market_pnl = lp_pnl.saturating_add(share(
        invested,
        stream.between(FIFO_ADJUSTMENT_BPS.0, FIFO_ADJUSTMENT_BPS.1),
    )?);
    let strategy = [Strategy::Spot, Strategy::Curve, Strategy::BidAsk]
        .get(usize::try_from(stream.below(3)).unwrap_or(0))
        .copied()
        .unwrap_or(Strategy::Spot);
    let (invested, withdrawn, fees) = match shape {
        Shape::Shell => (0, 0, 0),
        _ => (
            invested,
            invested.saturating_add(lp_pnl).saturating_sub(fees),
            fees,
        ),
    };
    Ok(ClosedPositionFacts {
        id: PositionId {
            address: address(&format!("position:{label}")),
            opened_by: signature(&format!("open:{label}")),
        },
        wallet: plan.wallet,
        pool: pool.facts.address,
        strategy,
        opened_at: Timestamp::from_second(opened).map_err(|_| DemoError::OutOfRange)?,
        closed_at,
        invested: QuoteUnits(invested),
        withdrawn: QuoteUnits(withdrawn),
        claimed_fees: QuoteUnits(fees),
        method: if is_fifo && shape != Shape::Shell {
            PnlMethod::Fifo {
                market_pnl: QuoteUnits(market_pnl),
            }
        } else {
            PnlMethod::Pool
        },
        unpriced_movements: u32::from(stream.below(400) == 0 && shape == Shape::Ordinary),
    })
}

/// `lamports` in the pool's quote token, at the rate of the day of `instant`.
pub(crate) fn in_quote(
    lamports: i128,
    asset: QuoteAsset,
    rates: &SolUsdRates,
    instant: Timestamp,
) -> Result<i128, DemoError> {
    if asset == QuoteAsset::Sol {
        return Ok(lamports);
    }
    let rate = rates
        .on(instant)
        .or(rates.spot)
        .ok_or(DemoError::OutOfRange)?;
    Ok(rate.to_usd(SignedLamports(lamports))?.0)
}

/// `bps` basis points of `amount`.
pub(crate) fn share(amount: i128, bps: i64) -> Result<i128, DemoError> {
    amount
        .checked_mul(i128::from(bps))
        .and_then(|scaled| scaled.checked_div(BASIS_POINTS))
        .ok_or(DemoError::OutOfRange)
}

/// Makes one position reuse the account address of an earlier, closed one in the same pool, as
/// when a position account is closed and created again: two lives, two ids, one address.
fn recreate_one_address(positions: &mut [ClosedPositionFacts]) {
    let found = positions.iter().enumerate().find_map(|(earlier, first)| {
        positions
            .iter()
            .position(|later| later.pool == first.pool && later.opened_at > first.closed_at)
            .map(|later| (earlier, later))
    });
    let Some((earlier, later)) = found else {
        return;
    };
    if let Some(address) = positions.get(earlier).map(|first| first.id.address)
        && let Some(later) = positions.get_mut(later)
    {
        later.id.address = address;
    }
}
