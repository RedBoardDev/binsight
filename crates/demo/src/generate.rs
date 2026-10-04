//! Builds the facts of the demo world from the scenario, wallet by wallet.
//!
//! The order matters: the catalog and the price paths first, then each wallet's positions and
//! entries, then the top-ups its cash needs, then its idle SOL and its marks, which both follow
//! from the rest. Nothing reads the clock: the anchor instant and the time zone come in the spec.

mod closed;
mod entries;
mod events;
mod instance;
mod market;
mod marks;
mod open;
mod sweep;
mod wallet;

use std::collections::BTreeMap;

use binsight_engine::portfolio::{InstanceStatus, SnapshotFacts};
use binsight_ledger::facts::{PoolFacts, PositionEventFact};
use binsight_ledger::report::period::{local_day, midnight};
use binsight_solana::Address;
use jiff::{SignedDuration, Timestamp, ToSpan};

use crate::error::DemoError;
use crate::scenario::{HISTORY_DAYS, WALLETS, WalletProfile};
use crate::world::WorldSpec;
use events::{Market, closed_events, open_events};
use market::{
    Catalog, CatalogPool, PricePath, catalog, following_rates, random_walk, sol_usd_rates,
    token_logos,
};

/// Seconds in an hour.
const SECONDS_PER_HOUR: i64 = 3_600;

/// The instants every generator needs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Timeline {
    /// "Now" for the generated world.
    pub(crate) anchor: Timestamp,
    /// Local midnight of the anchor's day.
    pub(crate) today: Timestamp,
    /// Local midnight of the day before.
    pub(crate) yesterday: Timestamp,
    /// The first hour of the generated history.
    pub(crate) first_hour: Timestamp,
}

/// The facts of a generated world and the state of its instance.
pub(crate) struct Generated {
    /// The facts.
    pub(crate) facts: SnapshotFacts,
    /// The instance.
    pub(crate) status: InstanceStatus,
}

/// Generates the world of `spec`.
pub(crate) fn generate(spec: &WorldSpec) -> Result<Generated, DemoError> {
    let timeline = timeline(spec)?;
    let catalog = catalog(spec.seed)?;
    let first_day = local_day(timeline.first_hour, &jiff::tz::TimeZone::UTC);
    let last_day = local_day(timeline.anchor, &jiff::tz::TimeZone::UTC);
    let rates = sol_usd_rates(spec.seed, first_day, last_day)?;
    let paths = price_paths(spec.seed, &catalog, &rates, &timeline)?;
    let long_tail = long_tail_closes(spec.seed, &catalog);
    let mut facts = SnapshotFacts {
        pools: catalog
            .pools
            .iter()
            .map(|pool| pool.facts.clone())
            .collect(),
        tokens: vec![catalog.unpriced_token.clone()],
        logos: token_logos(&catalog),
        rates,
        ..SnapshotFacts::default()
    };
    for profile in &WALLETS {
        let tail = long_tail.get(profile.label).cloned().unwrap_or_default();
        let context = wallet::WalletContext {
            seed: spec.seed,
            catalog: &catalog,
            paths: &paths,
            timeline: &timeline,
        };
        wallet::generate_wallet(&context, profile, tail, &mut facts)?;
    }
    let paths: BTreeMap<Address, PricePath> = catalog
        .pools
        .iter()
        .filter_map(|pool| Some((pool.facts.address, paths.get(&pool.key)?.clone())))
        .collect();
    facts.events = position_events(spec.seed, &facts, &paths, timeline.anchor)?;
    Ok(Generated {
        facts,
        status: instance::instance_status(timeline.anchor),
    })
}

/// The movements of every position of `facts`, on the price paths of their pools.
fn position_events(
    seed: u64,
    facts: &SnapshotFacts,
    paths: &BTreeMap<Address, PricePath>,
    now: Timestamp,
) -> Result<Vec<PositionEventFact>, DemoError> {
    let pools: BTreeMap<Address, &PoolFacts> = facts
        .pools
        .iter()
        .map(|pool| (pool.address, pool))
        .collect();
    let market = |pool: Address| -> Result<Market<'_>, DemoError> {
        Ok(Market {
            pool: pools.get(&pool).copied().ok_or(DemoError::UnknownPool)?,
            path: paths.get(&pool).ok_or(DemoError::UnknownPool)?,
        })
    };
    let mut events = Vec::new();
    for position in &facts.closed {
        events.extend(closed_events(seed, position, market(position.pool)?)?);
    }
    for position in &facts.open {
        events.extend(open_events(seed, position, market(position.pool)?, now)?);
    }
    Ok(events)
}

/// The instants of the world of `spec`.
fn timeline(spec: &WorldSpec) -> Result<Timeline, DemoError> {
    let today_date = local_day(spec.anchor, &spec.timezone);
    let yesterday_date = today_date
        .checked_sub(1.day())
        .map_err(|_| DemoError::OutOfRange)?;
    let start = spec
        .anchor
        .checked_sub(SignedDuration::from_hours(HISTORY_DAYS.saturating_mul(24)))
        .map_err(|_| DemoError::OutOfRange)?;
    let first_hour = start
        .as_second()
        .saturating_div(SECONDS_PER_HOUR)
        .saturating_mul(SECONDS_PER_HOUR);
    Ok(Timeline {
        anchor: spec.anchor,
        today: midnight(today_date, &spec.timezone).map_err(|_| DemoError::OutOfRange)?,
        yesterday: midnight(yesterday_date, &spec.timezone).map_err(|_| DemoError::OutOfRange)?,
        first_hour: Timestamp::from_second(first_hour).map_err(|_| DemoError::OutOfRange)?,
    })
}

/// The price path of every pool, keyed by pool key.
fn price_paths(
    seed: u64,
    catalog: &Catalog,
    rates: &binsight_ledger::facts::SolUsdRates,
    timeline: &Timeline,
) -> Result<BTreeMap<String, PricePath>, DemoError> {
    let span = timeline
        .anchor
        .duration_since(timeline.first_hour)
        .as_secs();
    let hours = usize::try_from(span.saturating_div(SECONDS_PER_HOUR).saturating_add(2))
        .map_err(|_| DemoError::OutOfRange)?;
    catalog
        .pools
        .iter()
        .map(|pool| {
            let path = if pool.facts.base.kind == binsight_ledger::facts::TokenKind::Sol {
                following_rates(seed, pool, rates, timeline.first_hour, hours)?
            } else {
                random_walk(seed, pool, timeline.first_hour, hours)
            };
            Ok((pool.key.clone(), path))
        })
        .collect()
}

/// How many closes each long-tail pool has, and which wallet made each, by wallet label.
fn long_tail_closes(seed: u64, catalog: &Catalog) -> BTreeMap<&'static str, Vec<&CatalogPool>> {
    let mut assigned: BTreeMap<&'static str, Vec<&CatalogPool>> = BTreeMap::new();
    let takers: Vec<&WalletProfile> = WALLETS
        .iter()
        .filter(|profile| profile.long_tail_share > 0)
        .collect();
    for pool in catalog.long_tail() {
        let mut stream = crate::random::Stream::of(seed, &format!("tail:{}", pool.key));
        let closes = stream.below(15).saturating_add(1);
        for _ in 0..closes {
            let mut drawn = stream.below(100);
            let taker = takers.iter().find(|profile| {
                let is_chosen = drawn < profile.long_tail_share;
                drawn = drawn.saturating_sub(profile.long_tail_share);
                is_chosen
            });
            if let Some(profile) = taker.or(takers.first()) {
                assigned.entry(profile.label).or_default().push(pool);
            }
        }
    }
    assigned
}
