//! # binsight-dlmm
//!
//! **Responsibility:** everything specific to the Meteora DLMM program: its identifier and event
//! tag, the fixed-point maths of its bins, and later its account layouts and its Event-CPI
//! decoding.
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

pub mod math;
pub mod program;
