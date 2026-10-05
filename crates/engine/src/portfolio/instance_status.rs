//! The state of the instance that is not about one wallet: the engine, the chain tip and the
//! credits of the billing cycle.

use jiff::Timestamp;

use super::views::{BillingCycle, ChainTip};
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
    /// Exact cycle boundaries supplied by the source's credit governor.
    pub credit_cycle: BillingCycle,
    /// The credits spent in the current billing cycle.
    pub credits_used: u64,
    /// The billing cycle's credit budget.
    pub credits_budget: u64,
}
