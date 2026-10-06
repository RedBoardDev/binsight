//! The accounts and programs on the other side of a wallet's transfers that the ledger knows by
//! address: the tip accounts of transaction-landing services ([`landing_service`]) and the
//! programs of cross-chain bridges ([`bridge_of`]).
//!
//! Both lists change what is booked: a tip is a cost instead of a protocol loss, a bridge flow is
//! capital instead of PnL, so the projections built on booked entries must be rebuilt when one
//! changes. This module only recognises addresses; booking decides what a transfer to them is.

mod bridges;
mod landing_tips;

pub use bridges::{BridgeId, bridge_called_by, bridge_of};
pub use landing_tips::{LandingService, landing_service};
