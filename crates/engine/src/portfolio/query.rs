//! The queries: pure functions from a snapshot to a view.
//!
//! A source of figures only provides the snapshot (and the state of the instance); the queries
//! filter, sort and page it, and call the read rules of `binsight_ledger::report` for every
//! figure. They never read the clock (the instant is in the [`super::scope::ReadContext`]) and
//! never do I/O, so the demo world and the engine answer with the same semantics.

mod scope_figures;
mod sync;
mod wallets;

pub use sync::sync_report;
pub use wallets::wallets;
