//! # binsight-ledger
//!
//! **Responsibility:** the accounting of binsight. Today: the [`facts`] the accounting produces
//! about each wallet (positions, entries, marks, holdings, rates) and the [`report`] rules that
//! turn them into the figures the screens show (windows, exactness, valuation). Later: typed
//! ledger entries, liquidity position PnL and FIFO cost basis, which produce those facts from the
//! chain.
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

pub mod facts;
pub mod report;
