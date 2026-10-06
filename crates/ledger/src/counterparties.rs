//! The accounts on the other side of a wallet's transfers that the ledger knows by address: the
//! tip accounts of transaction-landing services ([`landing_service`]).
//!
//! The list changes what is booked: a tip is a cost instead of a protocol loss or a swap leg, so
//! the projections built on booked entries must be rebuilt when it changes. This module only
//! recognises addresses; booking decides what a transfer to them is.

mod landing_tips;

pub use landing_tips::{LandingService, landing_service};
