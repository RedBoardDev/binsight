//! The routes of the overview screen: the overview itself, the open positions and the recent
//! closes.
//!
//! Each route lives in its own file with its wire types; this module only gathers them.

pub(crate) mod open_positions;
pub(crate) mod recent_closes;
pub(crate) mod summary;
mod watch;
