//! # binsight-core
//!
//! **Responsibility:** the shared vocabulary of binsight, with no I/O: integer money units, exact
//! decimal strings, the exactness status of a figure and an injectable clock.
//!
//! **May depend on:** no other binsight crate.
//! **Must not depend on:** any other binsight crate, nor any I/O, async or serialization crate.
//! (Checked in CI by `cargo xtask layering`.)
//!
//! This crate is pure: no I/O, no floating point, no `as` casts, only checked arithmetic.

#![deny(
    clippy::float_arithmetic,
    clippy::float_cmp,
    clippy::as_conversions,
    clippy::arithmetic_side_effects
)]

pub mod clock;
pub mod decimal;
pub mod error;
pub mod exactness;
pub mod units;
