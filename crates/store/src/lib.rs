//! # binsight-store
//!
//! **Responsibility:** the only crate that touches the SQLite database file. It owns the schema,
//! the embedded migrations, the backups and the typed repositories of the three data layers.
//!
//! **May depend on:** `binsight-core`, `binsight-solana`, `binsight-dlmm`, `binsight-ledger`.
//! **Must not depend on:** `binsight-chain`, `binsight-engine`, `binsight-api`, any HTTP crate.
//! (Checked in CI by `cargo xtask layering`.)
//!
//! **Start here:** [`Store::open_and_upgrade`].
//!
//! The data lives in three layers: the raw transactions ([`Store::raw_tx`]), immutable; the
//! decoded events ([`Store::decoded`]), versioned by decoder; and the disposable projections
//! ([`Store::projections`]), versioned by calculation. Instance settings live in
//! [`Store::meta`].
//!
//! Inside the crate, SQL runs in plain synchronous functions that receive a connection; only the
//! connection pools in `pools` run them, on a blocking thread. Callers outside the crate see typed
//! async methods and never a SQLite type.

mod codec;
mod decoded;
mod error;
mod meta;
mod pools;
mod projections;
mod raw_tx;
mod store;
#[cfg(test)]
mod test_database;
mod upgrade;

pub use decoded::{DecodeOutcome, DecodeRecord, DecodedEvent, DecodedRepo};
pub use error::StoreError;
pub use meta::{MetaKey, MetaRepo};
pub use projections::{ProjectionMetaRepo, ProjectionState, ProjectionStatus};
pub use raw_tx::{
    Commitment, PayloadCompression, PayloadEncoding, RawTxRecord, RawTxRepo, TxVersion,
};
pub use store::Store;
pub use upgrade::{SchemaStatus, UpgradeOptions, UpgradeReport};
