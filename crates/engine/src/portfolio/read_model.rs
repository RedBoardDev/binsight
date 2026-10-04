//! The read port: everything the API can ask about the portfolio, split by area.
//!
//! Each area is a trait with a file of its own; [`ReadModel`] is all of them together and is
//! what a source of figures implements (the demo world today, the engine later). Every method
//! answers a boxed future, so a source can be shared as `Arc<dyn ReadModel>`.

mod instance;
mod portfolio;
mod positions;
mod stats;
mod wallets;

pub use instance::InstanceReads;
pub use portfolio::PortfolioReads;
pub use positions::PositionReads;
pub use stats::StatsReads;
pub use wallets::WalletReads;

/// Everything the API reads, implemented once per source of figures.
pub trait ReadModel:
    InstanceReads + WalletReads + PortfolioReads + PositionReads + StatsReads
{
}

impl<T> ReadModel for T where
    T: InstanceReads + WalletReads + PortfolioReads + PositionReads + StatsReads
{
}
