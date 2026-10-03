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
//!
//! **Start here:** [`HeliusApiKey`]. The client itself comes with ingestion; for now the crate only
//! validates the key, so the configuration is complete from the first release and binsight starts
//! without any network access.

mod helius_key;

pub use helius_key::{HeliusApiKey, HeliusKeyError};
