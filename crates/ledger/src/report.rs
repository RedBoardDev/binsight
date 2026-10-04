//! The read rules: how every figure the screens show is computed from the facts.
//!
//! Each rule lives here once and is shared by every source of facts (the accounting of the chain,
//! the demo world): time windows and buckets, the exactness of a figure and how it combines, and
//! the valuation of amounts in SOL and dollars. This module computes; it never reads the clock or
//! any I/O.

pub mod figure;
pub mod period;
pub mod valued;
