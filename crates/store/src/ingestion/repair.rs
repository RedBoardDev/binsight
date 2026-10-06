//! Repairs of the wallets' listings: where each one stands (`state`), and what a repair listing
//! found (`page`).
//!
//! A repair lists a wallet again at the finalized commitment and fills the gaps it finds without
//! moving the cursor. This module stores what the engine decided; when and how far to repair is
//! the engine's job.

mod page;
mod state;

pub use page::{RepairFindings, RepairPage};
pub use state::{RepairsRepo, WalletRepair};
