//! # binsight-store
//!
//! **Responsibility:** the only crate that touches the SQLite database file. It owns the schema,
//! the embedded migrations, the backups and the typed repositories of the three data layers.
//!
//! **May depend on:** `binsight-core`, `binsight-solana`, `binsight-dlmm`, `binsight-ledger`.
//! **Must not depend on:** `binsight-chain`, `binsight-engine`, `binsight-api`, any HTTP crate.
//! (Checked in CI by `cargo xtask layering`.)
//!
//! **Start here:** [`Store`].
//!
//! Inside the crate, SQL runs in plain synchronous functions that receive a connection; only the
//! connection pools in `pools` run them, on a blocking thread. Callers outside the crate see typed
//! async methods and never a SQLite type.

mod codec;
mod error;
mod pools;
mod store;
mod upgrade;

pub use error::StoreError;
pub use store::Store;
pub use upgrade::{SchemaStatus, UpgradeOptions, UpgradeReport};
