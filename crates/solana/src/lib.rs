//! # binsight-solana
//!
//! **Responsibility:** Solana primitives without any network access: base58 addresses,
//! transaction signatures, commitment levels and transaction formats (later: reading legacy, v0
//! and v1 transactions).
//!
//! **May depend on:** `binsight-core`.
//! **Must not depend on:** `binsight-dlmm`, `binsight-ledger`, `binsight-store`, `binsight-chain`,
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

pub mod address;
mod base58;
pub mod commitment;
pub mod error;
pub mod signature;
pub mod transaction;

pub use address::Address;
pub use commitment::Commitment;
pub use error::ParseError;
pub use signature::Signature;
