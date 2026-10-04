//! The state of the instance that is not about one wallet: the engine, the chain tip and the
//! credits of the month.

use jiff::Timestamp;

use super::views::ChainTip;
use crate::status::EngineStatus;

/// The state of the instance, as its source last saw it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InstanceStatus {
    /// Where the engine is in its lifecycle.
    pub engine: EngineStatus,
    /// When the engine started.
    pub started_at: Timestamp,
    /// The last slot seen.
    pub chain: ChainTip,
    /// How often open positions are valued, in seconds, when they are.
    pub valuation_interval_seconds: Option<u64>,
    /// The credits spent in the current UTC month.
    pub credits_used: u64,
    /// The monthly credit budget.
    pub credits_budget: u64,
}
