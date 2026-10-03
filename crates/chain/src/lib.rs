//! # binsight-chain
//!
//! **Responsibility:** the only crate that talks to the Solana network, through Helius: the
//! JSON-RPC and WebSocket client, the credit counter and the budget governor. It knows nothing
//! about DLMM.
//!
//! **May depend on:** `binsight-core`, `binsight-solana`.
//! **Must not depend on:** `binsight-dlmm`, `binsight-ledger`, `binsight-store`, `binsight-engine`,
//! `binsight-api`.
//! (Checked in CI by `cargo xtask layering`.)
