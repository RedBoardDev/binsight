//! The routes about one position and its tokens: the position with its chart, its movements,
//! the candles of its chart, and the token logos.
//!
//! Each route lives in its own file with its wire types; this module only gathers them.

pub(crate) mod candles;
mod chart;
pub(crate) mod detail;
pub(crate) mod events;
pub(crate) mod logo;
mod position_id;
