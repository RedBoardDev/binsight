//! # binsight-store
//!
//! **Responsibility:** the only crate that touches the SQLite database file. It owns the schema,
//! the embedded migrations, the backups and the typed repositories of the three data layers.
//!
//! **May depend on:** `binsight-core`, `binsight-solana`, `binsight-dlmm`, `binsight-ledger`.
//! **Must not depend on:** `binsight-chain`, `binsight-engine`, `binsight-api`, any HTTP crate.
//! (Checked in CI by `cargo xtask layering`.)
