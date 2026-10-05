//! # binsight-solana
//!
//! **Responsibility:** Solana primitives without any network access: base58 addresses,
//! transaction signatures, commitment levels, reading legacy, version 0 and version 1
//! transactions from a node's answer, decoding the instructions of the native and SPL programs,
//! and the little-endian byte cursor other programs' decoders read their fields with.
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
mod byte_reader;
pub mod commitment;
pub mod error;
pub mod program_address;
pub mod programs;
pub mod signature;
pub mod transaction;
pub mod well_known;

pub use address::Address;
pub use byte_reader::ByteReader;
pub use commitment::Commitment;
pub use error::{MalformedBytes, ParseError};
pub use signature::Signature;
