//! # binsight-engine
//!
//! **Responsibility:** orchestration. It runs the engine lifecycle, schedules the work (later: one
//! actor per wallet), publishes domain events and keeps projections in step with their calculation
//! versions.
//!
//! **May depend on:** `binsight-core`, `binsight-solana`, `binsight-dlmm`, `binsight-ledger`,
//! `binsight-store`, `binsight-chain`.
//! **Must not depend on:** `binsight-api`, any HTTP crate.
//! (Checked in CI by `cargo xtask layering`.)
