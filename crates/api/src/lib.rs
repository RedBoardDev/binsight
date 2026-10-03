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

pub mod auth;
mod error;
mod health;
mod layers;
mod live;
pub mod openapi;
mod router;
mod server;
mod state;
mod web_app;

pub use router::router;
pub use server::serve;
pub use state::{AppState, AppStateParts};
pub use web_app::{WebAsset, WebAssets};
