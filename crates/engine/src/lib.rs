//! # binsight-engine
//!
//! **Responsibility:** orchestration. It runs the engine lifecycle, ingests each tracked wallet's
//! history into the raw registry (listing, then fetching every transaction once), persists the
//! credits spent, publishes domain events, keeps projections in step with their calculation
//! versions and answers the API's reads of the portfolio (see [`portfolio`]).
//!
//! **May depend on:** `binsight-core`, `binsight-solana`, `binsight-dlmm`, `binsight-ledger`,
//! `binsight-store`, `binsight-chain`.
//! **Must not depend on:** `binsight-api`, any HTTP crate.
//! (Checked in CI by `cargo xtask layering`.)
//!
//! **Start here:** [`Engine::new`] builds the engine and its [`EngineHandle`]; [`Engine::run`]
//! runs it until shutdown. The rest of the application only ever talks to the handle.

mod clock;
mod credit_usage;
mod engine;
mod error;
mod events;
mod handle;
mod health;
mod ingestion;
pub mod portfolio;
pub mod projections;
mod status;
#[cfg(any(test, feature = "test-support"))]
pub mod test_support;

pub use clock::SystemClock;
pub use engine::Engine;
pub use error::EngineError;
pub use events::EngineEvent;
pub use handle::EngineHandle;
pub use health::{ComponentHealth, EngineHealth};
pub use status::EngineStatus;
