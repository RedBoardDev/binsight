//! The routes of History: the infinite list of closed positions and the pools of its filter.
//!
//! Each route lives in its own file with its wire types; this module only gathers them.

pub(crate) mod closed;
mod filters;
pub(crate) mod pools;

mod rates;
