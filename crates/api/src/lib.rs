//! # binsight-api
//!
//! **Responsibility:** the HTTP interface: the versioned REST API, the live event stream (SSE),
//! password authentication, the OpenAPI contract and serving the web app. Wire types live here and
//! are converted explicitly from the domain types.
//!
//! **May depend on:** `binsight-core`, `binsight-solana`, `binsight-dlmm`, `binsight-ledger`,
//! `binsight-engine`.
//! **Must not depend on:** `binsight-store`, `binsight-chain` (everything goes through the engine).
//! (Checked in CI by `cargo xtask layering`.)
