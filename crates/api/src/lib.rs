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
//!
//! **Start here:** [`router`] builds the application from an [`AppState`]; [`serve`] runs it.
//! Every error answers with the same JSON body, built in `error`. Authentication settings come
//! from [`auth`]; the files of the web app from any [`WebAssets`] source.

mod app;
pub mod auth;
mod contract;
mod error;
mod instance;
mod live;
pub mod openapi;

pub use app::{AppState, AppStateParts, INDEX_FILE, WebAsset, WebAssets, router, serve};
