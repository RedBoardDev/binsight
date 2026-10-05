//! Valuation figures carry their exactness and the reasons for unavailable or degraded inputs.
//!
//! This foundation combines figure quality without reading the clock or any I/O. Position and
//! wallet computations will consume the same facts and figure types.

pub mod figure;
