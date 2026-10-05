//! The routes about the instance itself: its health, its synchronization, its settings and the
//! wallets it tracks.
//!
//! Each route lives in its own file with its wire types; this module only gathers them.

pub(crate) mod health;
pub(crate) mod settings;
pub(crate) mod sync;
pub(crate) mod wallets;
