//! The portfolio as the API reads it: the read port, its views and the queries behind them.
//!
//! The API asks through the [`ReadModel`] traits and never sees where the figures come from.
//! A source of figures builds a [`Snapshot`] of its facts and answers each read by running the
//! matching query on it, so the demo world and the engine share every rule. In chain mode, until
//! the engine serves figures, [`NotReadyPortfolio`] answers that nothing is ready.

mod answer;
mod data_source;
mod instance_status;
mod not_ready;
pub mod query;
mod read_error;
mod read_model;
mod scope;
mod snapshot;
pub mod views;
mod wallet_label;

pub use answer::{Answer, answered};
pub use data_source::DataSourceKind;
pub use instance_status::InstanceStatus;
pub use not_ready::NotReadyPortfolio;
pub use read_error::ReadError;
pub use read_model::{
    HistoryReads, InstanceReads, PortfolioReads, PositionReads, ReadModel, StatsReads, WalletReads,
};
pub use scope::{ReadContext, Scope};
pub use snapshot::{
    ClosedRow, OpenRow, PositionRow, Snapshot, SnapshotError, SnapshotFacts, TokenLogoFacts,
    TrackedWallet,
};
pub use wallet_label::{MAX_WALLET_LABEL_CHARS, WalletLabel, WalletLabelError};
