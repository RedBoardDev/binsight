//! The demo world: the snapshot the queries read and the state of the demo instance.

use std::collections::BTreeMap;

use binsight_core::ratio::Percent;
use binsight_engine::portfolio::views::{InstanceSettings, TimezoneSource};
use binsight_engine::portfolio::{InstanceStatus, Snapshot};
use binsight_ledger::report::valued::Currency;
use binsight_solana::Address;
use jiff::Timestamp;
use jiff::tz::TimeZone;

use crate::error::DemoError;
use crate::generate::{PricePath, generate};
use crate::scenario::DEMO_SEED;

/// What a demo world is generated from.
#[derive(Debug, Clone, PartialEq)]
pub struct WorldSpec {
    /// The seed: the same seed, anchor and time zone always give the same world.
    pub seed: u64,
    /// "Now" for the world: the latest instant anything happened.
    pub anchor: Timestamp,
    /// The time zone that decides where "today" starts.
    pub timezone: TimeZone,
    /// An optional synthetic wallet whose history is still being indexed.
    pub importing_wallet: Option<ImportingWalletSpec>,
    /// Which variant of the world: the showcase of every state, or the nominal one.
    pub profile: WorldProfile,
}

/// The variant of the demo world.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum WorldProfile {
    /// Every state a screen must handle: a wallet lagging behind the chain, wallets added after
    /// their first activity (their earlier history is reconstructed, hence estimated).
    #[default]
    Showcase,
    /// The calm, nominal instance a screen is compared against: every wallet live and tracked
    /// since its first activity. The same trades, prices and holdings as the showcase (the
    /// unpriced token is still held, so a lower bound remains where it is genuine).
    Nominal,
}

impl WorldSpec {
    /// The default world, anchored at `anchor` in `timezone`.
    pub fn new(anchor: Timestamp, timezone: TimeZone) -> Self {
        Self {
            seed: DEMO_SEED,
            anchor,
            timezone,
            importing_wallet: None,
            profile: WorldProfile::Showcase,
        }
    }
}

/// The synthetic history import to simulate in a demo world.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ImportingWalletSpec {
    /// The zero-based wallet index in the deterministic scenario.
    pub wallet_index: usize,
    /// The oldest indexed instant, or none before the first history page.
    pub indexed_since: Option<Timestamp>,
    /// Import progress between zero and one hundred percent, or none when the total is unknown.
    pub progress: Option<Percent>,
}

/// A generated world.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct World {
    /// The instant shared by every generated fact and financial read.
    pub(crate) anchor: Timestamp,
    /// The facts, valued and indexed.
    pub(crate) snapshot: Snapshot,
    /// The state of the demo instance.
    pub(crate) status: InstanceStatus,
    /// The time zone the world was generated in.
    pub(crate) timezone: TimeZone,
    /// The settings of the demo instance.
    pub(crate) settings: InstanceSettings,
    /// The price path of every pool, by pool address: the demo's market data.
    pub(crate) paths: BTreeMap<Address, PricePath>,
    /// The pool the demo's market data source does not know.
    pub(crate) unindexed_pool: Option<Address>,
}

impl World {
    /// Generates the world of `spec`.
    pub(crate) fn generate(spec: &WorldSpec) -> Result<Self, DemoError> {
        let generated = generate(spec)?;
        Ok(Self {
            anchor: spec.anchor,
            snapshot: Snapshot::new(generated.facts)?,
            status: generated.status,
            timezone: spec.timezone.clone(),
            settings: InstanceSettings {
                timezone: spec.timezone.iana_name().unwrap_or("UTC").to_owned(),
                timezone_source: TimezoneSource::Default,
                default_currency: Currency::Sol,
                hide_amounts_by_default: false,
            },
            paths: generated.paths,
            unindexed_pool: generated.unindexed_pool,
        })
    }
}

#[cfg(test)]
mod tests;
