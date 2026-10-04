//! # binsight-dlmm
//!
//! **Responsibility:** everything specific to the Meteora DLMM program: its identity, the events
//! it emits ([`event::decode_events`]), what they did to positions
//! ([`activity::position_activity`]), the kind of each of its instructions
//! ([`instruction::classify`]), and the name and version under which their decoding is stored.
//! Later: its account layouts and the fixed-point maths of its bins.
//!
//! **May depend on:** `binsight-core`, `binsight-solana`.
//! **Must not depend on:** `binsight-ledger`, `binsight-store`, `binsight-chain`,
//! `binsight-engine`, `binsight-api`, and any I/O or async crate.
//! (Checked in CI by `cargo xtask layering`.)
//!
//! This crate is pure: no I/O, no floating point, no `as` casts, only checked arithmetic.

#![deny(
    clippy::float_arithmetic,
    clippy::float_cmp,
    clippy::as_conversions,
    clippy::arithmetic_side_effects
)]

pub mod activity;
pub mod decoder_version;
pub mod event;
pub mod instruction;
pub mod program;

#[cfg(test)]
mod test_events;

pub use activity::{TxActivity, position_activity};
pub use decoder_version::{DECODER_NAME, DECODER_VERSION};
pub use event::{DlmmEvent, LocatedEvent, decode_events};
