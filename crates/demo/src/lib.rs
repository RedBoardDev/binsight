//! # binsight-demo
//!
//! **Responsibility:** a generated portfolio, realistic and coherent, that stands in for the
//! chain when binsight runs in demo mode (`BINSIGHT_DEMO=true`): three wallets, eighteen months
//! of closed positions, open positions with their bins, entries, rates and the state of the
//! instance. The world only holds facts; every figure comes from the same queries and read rules
//! as the engine's, so the demo and the chain answer alike.
//!
//! **Never does:** write to the store or reach the network (it does not depend on either), read
//! the clock while generating (the anchor instant is a parameter), or use a real address (every
//! identifier is a hash of a label).
//!
//! **May depend on:** `binsight-core`, `binsight-solana`, `binsight-dlmm`, `binsight-ledger`,
//! `binsight-engine`. Only the binary depends on it (and the API's tests).
//! (Checked in CI by `cargo xtask layering`.)
//!
//! **Start here:** [`DemoPortfolio::new`] generates the world of a [`WorldSpec`].

#![deny(
    clippy::float_arithmetic,
    clippy::float_cmp,
    clippy::as_conversions,
    clippy::arithmetic_side_effects
)]

mod addresses;
mod error;
mod generate;
mod portfolio;
mod random;
mod scenario;
mod world;

pub use error::DemoError;
pub use portfolio::DemoPortfolio;
pub use scenario::DEMO_SEED;
pub use world::WorldSpec;
