//! # binsight-ledger
//!
//! **Responsibility:** the accounting of binsight: transaction booking, typed ledger entries,
//! liquidity position PnL, FIFO cost basis, net worth and curves. The [`facts`] describe wallet
//! accounting and the [`report`] rules turn those facts into the figures shown by the screens.
//!
//! **May depend on:** `binsight-core`, `binsight-solana`, `binsight-dlmm`.
//! **Must not depend on:** `binsight-store`, `binsight-chain`, `binsight-engine`, `binsight-api`,
//! and any I/O or async crate.
//! (Checked in CI by `cargo xtask layering`.)
//!
//! This crate is pure: no I/O, no floating point, no `as` casts, only checked arithmetic.

#![deny(
    clippy::float_arithmetic,
    clippy::float_cmp,
    clippy::as_conversions,
    clippy::arithmetic_side_effects
)]

/// Typed accounting of each wallet transaction.
pub mod book;
pub mod facts;
pub mod report;
