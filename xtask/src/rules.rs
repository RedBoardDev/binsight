//! The layering rules of the workspace, as plain tables.
//!
//! This file is the single place that says which crate may use which. It holds data only; the
//! checks that apply it live in `layering.rs`. Changing a rule is a deliberate, reviewed edit of
//! this file.

/// The workspace crates a crate is allowed to depend on.
///
/// The list says what is *allowed*, not what is used: a crate declares a dependency only when it
/// needs it. Every workspace member must appear here, so a new crate cannot slip in unchecked.
pub(crate) struct CrateRule {
    /// The package name of the crate.
    pub(crate) name: &'static str,
    /// The workspace crates it may depend on (normal, build and dev dependencies alike).
    pub(crate) may_depend_on: &'static [&'static str],
}

const CORE: &str = "binsight-core";
const SOLANA: &str = "binsight-solana";
const DLMM: &str = "binsight-dlmm";
const LEDGER: &str = "binsight-ledger";
const STORE: &str = "binsight-store";
const CHAIN: &str = "binsight-chain";
const ENGINE: &str = "binsight-engine";
const API: &str = "binsight-api";
const BINARY: &str = "binsight";
const XTASK: &str = "xtask";

/// One-way dependencies: pure crates, then I/O, then the engine, the API and the binary on top.
/// Nobody may depend on `xtask`, and `binsight-api` sees neither the store nor the chain client.
pub(crate) const INTERNAL_ALLOWED: &[CrateRule] = &[
    CrateRule {
        name: CORE,
        may_depend_on: &[],
    },
    CrateRule {
        name: SOLANA,
        may_depend_on: &[CORE],
    },
    CrateRule {
        name: DLMM,
        may_depend_on: &[CORE, SOLANA],
    },
    CrateRule {
        name: LEDGER,
        may_depend_on: &[CORE, SOLANA, DLMM],
    },
    CrateRule {
        name: STORE,
        may_depend_on: &[CORE, SOLANA, DLMM, LEDGER],
    },
    CrateRule {
        name: CHAIN,
        may_depend_on: &[CORE, SOLANA],
    },
    CrateRule {
        name: ENGINE,
        may_depend_on: &[CORE, SOLANA, DLMM, LEDGER, STORE, CHAIN],
    },
    CrateRule {
        name: API,
        may_depend_on: &[CORE, SOLANA, DLMM, LEDGER, ENGINE],
    },
    CrateRule {
        name: BINARY,
        may_depend_on: &[CORE, SOLANA, DLMM, LEDGER, STORE, CHAIN, ENGINE, API],
    },
    CrateRule {
        name: XTASK,
        may_depend_on: &[],
    },
];

/// An external crate that only some workspace crates may use.
pub(crate) struct ExclusiveOwner {
    /// The external package name.
    pub(crate) dependency: &'static str,
    /// The only workspace crates allowed to depend on it.
    pub(crate) owners: &'static [&'static str],
}

/// External crates reserved to the crate that owns the concern. Applies to normal and build
/// dependencies; tests (dev dependencies) may use anything.
pub(crate) const EXCLUSIVE_OWNERS: &[ExclusiveOwner] = &[
    // Only Solana address derivation needs to reject ed25519 curve points.
    ExclusiveOwner {
        dependency: "curve25519-dalek",
        owners: &[SOLANA],
    },
    // The database file belongs to the store.
    ExclusiveOwner {
        dependency: "rusqlite",
        owners: &[STORE],
    },
    ExclusiveOwner {
        dependency: "deadpool-sqlite",
        owners: &[STORE],
    },
    ExclusiveOwner {
        dependency: "libsqlite3-sys",
        owners: &[STORE],
    },
    // Payload compression is a storage detail of the registry.
    ExclusiveOwner {
        dependency: "zstd",
        owners: &[STORE],
    },
    // The network belongs to the chain client.
    ExclusiveOwner {
        dependency: "reqwest",
        owners: &[CHAIN],
    },
    ExclusiveOwner {
        dependency: "tokio-tungstenite",
        owners: &[CHAIN],
    },
    // The capture of mainnet fixtures is tooling, outside the product: it may not use the chain
    // client (nothing may depend on a binsight crate from xtask), so it has its own blocking
    // HTTP client, which no product crate may use.
    ExclusiveOwner {
        dependency: "ureq",
        owners: &[XTASK],
    },
    // HTTP and sessions belong to the API.
    ExclusiveOwner {
        dependency: "axum",
        owners: &[API],
    },
    ExclusiveOwner {
        dependency: "axum-extra",
        owners: &[API],
    },
    ExclusiveOwner {
        dependency: "tower",
        owners: &[API],
    },
    ExclusiveOwner {
        dependency: "tower-http",
        owners: &[API],
    },
    ExclusiveOwner {
        dependency: "utoipa",
        owners: &[API],
    },
    ExclusiveOwner {
        dependency: "utoipa-axum",
        owners: &[API],
    },
    ExclusiveOwner {
        dependency: "hmac",
        owners: &[API],
    },
    ExclusiveOwner {
        dependency: "subtle",
        owners: &[API],
    },
    ExclusiveOwner {
        dependency: "cookie",
        owners: &[API],
    },
    // The command line, configuration files, log output and embedded web app belong to the binary.
    ExclusiveOwner {
        dependency: "clap",
        owners: &[BINARY],
    },
    ExclusiveOwner {
        dependency: "dialoguer",
        owners: &[BINARY],
    },
    ExclusiveOwner {
        dependency: "dotenvy",
        owners: &[BINARY],
    },
    ExclusiveOwner {
        dependency: "tracing-subscriber",
        owners: &[BINARY],
    },
    ExclusiveOwner {
        dependency: "rust-embed",
        owners: &[BINARY],
    },
    // Libraries return typed errors; only the binary and the tooling use catch-all errors.
    ExclusiveOwner {
        dependency: "anyhow",
        owners: &[BINARY, XTASK],
    },
];

/// The crates that must stay pure: no I/O, no async runtime, no logging.
pub(crate) const PURE_CRATES: &[&str] = &[CORE, SOLANA, DLMM, LEDGER];

/// The only external crates a pure crate may use (normal and build dependencies). Extending this
/// list is a deliberate decision.
pub(crate) const PURE_EXTERNAL_ALLOWLIST: &[&str] = &[
    "thiserror",
    "serde",
    "serde_json",
    "bs58",
    "base64",
    "borsh",
    "jiff",
    "sha2",
    "curve25519-dalek",
];
