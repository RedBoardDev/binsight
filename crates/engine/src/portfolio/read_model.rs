//! The read port: everything the API can ask about the portfolio, split by area.
//!
//! Each area is a trait with a file of its own; [`ReadModel`] is all of them together and is
//! what a source of figures implements (the demo world today, the engine later). Every method
//! answers a boxed future, so a source can be shared as `Arc<dyn ReadModel>`.
//!
//! Currency is an intentional input, unlike the first API plan: the pure ledger owns conversion
//! at each leaf's rate. The engine resolves figures and amount sort keys together before
//! pagination; the API only serializes those results. Keeping the selected currency here makes
//! the displayed amounts, their conversion quality and their server order agree.

mod history;
mod instance;
mod portfolio;
mod positions;
mod stats;
mod wallets;

pub use history::HistoryReads;
pub use instance::InstanceReads;
pub use portfolio::PortfolioReads;
pub use positions::PositionReads;
pub use stats::StatsReads;
pub use wallets::WalletReads;

/// Everything the API reads, implemented once per source of figures.
pub trait ReadModel:
    InstanceReads + WalletReads + PortfolioReads + HistoryReads + PositionReads + StatsReads
{
}

impl<T> ReadModel for T where
    T: InstanceReads + WalletReads + PortfolioReads + HistoryReads + PositionReads + StatsReads
{
}
