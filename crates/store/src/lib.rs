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
//! [`Store::meta`]. Ingestion keeps its bookkeeping next to them: the tracked wallets
//! ([`Store::wallets`]), their listed signatures ([`Store::signatures`]), the queue of
//! transactions to fetch ([`Store::fetch_queue`]) and the credits spent ([`Store::credits`]).
//!
//! Inside the crate, SQL runs in plain synchronous functions that receive a connection; only the
//! connection pools in `database` run them, on a blocking thread. Callers outside the crate see
//! typed async methods and never a SQLite type.
//!
//! Like the pure crates, the store never uses floating point: amounts are stored as exact text.

#![deny(clippy::float_arithmetic, clippy::float_cmp)]

mod credits;
mod database;
mod decoded;
mod error;
mod ingestion;
mod meta;
mod projections;
mod raw_tx;
mod store;
mod upgrade;

pub use credits::{CreditTotal, CreditUsage, CreditsRepo};
pub use decoded::{DecodeOutcome, DecodeRecord, DecodedEvent, DecodedRepo};
pub use error::StoreError;
pub use ingestion::{
    DetectedSignature, FetchCounts, FetchFailure, FetchQueueRepo, FetchSetback, FetchTask,
    FetchedTx, ListedSignature, ListedTop, ListingPage, RetryState, SignaturesRepo, TrackedWallet,
    WalletBacklog, WalletCursor, WalletsRepo,
};
pub use meta::{MetaKey, MetaRepo};
pub use projections::{ProjectionMetaRepo, ProjectionState, ProjectionStatus};
pub use raw_tx::{PayloadCompression, RawTxRecord, RawTxRepo};
pub use store::Store;
pub use upgrade::{BackupOptions, SchemaStatus, UpgradeOptions, UpgradeReport};
