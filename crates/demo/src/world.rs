//! The demo world: the snapshot the queries read and the state of the demo instance.

use binsight_engine::portfolio::views::{InstanceSettings, TimezoneSource};
use binsight_engine::portfolio::{InstanceStatus, Snapshot};
use binsight_ledger::report::valued::Currency;
use jiff::Timestamp;
use jiff::tz::TimeZone;

use crate::error::DemoError;
use crate::generate::generate;
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
}

impl WorldSpec {
    /// The default world, anchored at `anchor` in `timezone`.
    pub fn new(anchor: Timestamp, timezone: TimeZone) -> Self {
        Self {
            seed: DEMO_SEED,
            anchor,
            timezone,
        }
    }
}

/// A generated world.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct World {
    /// The facts, valued and indexed.
    pub(crate) snapshot: Snapshot,
    /// The state of the demo instance.
    pub(crate) status: InstanceStatus,
    /// The time zone the world was generated in.
    pub(crate) timezone: TimeZone,
    /// The settings of the demo instance.
    pub(crate) settings: InstanceSettings,
}

impl World {
    /// Generates the world of `spec`.
    pub(crate) fn generate(spec: &WorldSpec) -> Result<Self, DemoError> {
        let generated = generate(spec)?;
        Ok(Self {
            snapshot: Snapshot::new(generated.facts)?,
            status: generated.status,
            timezone: spec.timezone.clone(),
            settings: InstanceSettings {
                timezone: spec.timezone.iana_name().unwrap_or("UTC").to_owned(),
                timezone_source: TimezoneSource::Default,
                default_currency: Currency::Sol,
                hide_amounts_by_default: false,
            },
        })
    }
}

#[cfg(test)]
mod tests;
