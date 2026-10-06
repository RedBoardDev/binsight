//! Where the figures come from: the chain (with a Helius key) or the generated demo world, and
//! which clock the server reads.

use std::sync::Arc;

use binsight_chain::HeliusApiKey;
use binsight_core::clock::{Clock, FixedClock};
use binsight_engine::SystemClock;
use jiff::Timestamp;

/// Where binsight takes its figures from.
///
/// A Helius key only exists in chain mode, so a configuration cannot be in demo mode and still
/// spend credits, nor in chain mode without a key.
#[derive(Debug, Clone)]
pub enum DataSourceConfig {
    /// Track the owner's wallets on the chain, through Helius.
    Chain {
        /// The Helius API key.
        helius_api_key: HeliusApiKey,
    },
    /// Serve a generated demo world; no wallet is tracked and no credit is spent.
    Demo {
        /// The instant the clock is frozen at, so the same world and the same "now" come back on
        /// every start (screenshots compared with a reference); the wall clock when `None`.
        ///
        /// A frozen clock never lets time pass: failed sign-ins are never old enough to be
        /// forgotten, so a frozen demo that reaches the sign-in throttle stays throttled until it
        /// restarts.
        frozen_at: Option<Timestamp>,
    },
}

impl DataSourceConfig {
    /// The clock the server reads: frozen for a demo that asks for it, the wall clock otherwise.
    pub fn clock(&self) -> Arc<dyn Clock> {
        match self {
            Self::Demo {
                frozen_at: Some(instant),
            } => Arc::new(FixedClock::new(*instant)),
            Self::Demo { frozen_at: None } | Self::Chain { .. } => Arc::new(SystemClock),
        }
    }
}

/// Reads an on/off setting: `true` or `false`.
///
/// # Errors
///
/// Returns a message when the text is anything else.
pub(super) fn parse_switch(text: &str) -> Result<bool, &'static str> {
    match text {
        "true" => Ok(true),
        "false" => Ok(false),
        _ => Err("expected true or false"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn freezes_the_clock_of_a_demo_at_its_instant() {
        let instant: Timestamp = "2026-10-06T14:30:00Z".parse().unwrap();
        let demo = DataSourceConfig::Demo {
            frozen_at: Some(instant),
        };

        assert_eq!(demo.clock().now(), instant);
    }

    #[test]
    fn reads_the_wall_clock_when_the_demo_is_not_frozen() {
        let before = SystemClock.now();

        let now = DataSourceConfig::Demo { frozen_at: None }.clock().now();

        assert!(now >= before);
    }
}
