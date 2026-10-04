//! Signed money: SOL gains and losses, US dollars, and the SOL/USD rate between them.
//!
//! binsight counts SOL natively and derives US dollars from it, one leaf figure at a time (a
//! position, an entry), at the rate of the leaf's day; totals are sums of converted leaves, never
//! a converted total. This module defines the signed units and the conversion; deciding which
//! rate applies to which figure is the ledger's job.

mod signed_units;
mod sol_usd_rate;

pub use signed_units::{SignedLamports, UsdMicros};
pub use sol_usd_rate::SolUsdRate;
