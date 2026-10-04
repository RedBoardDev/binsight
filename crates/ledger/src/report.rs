//! The read rules: how every figure the screens show is computed from the facts.
//!
//! Each rule lives here once and is shared by every source of facts (the accounting of the chain,
//! the demo world): time windows and buckets, the exactness of a figure and how it combines, the
//! valuation of amounts in SOL and dollars, the totals of closed positions, the figures of open
//! positions, the net worth, the real PnL and its bridge, and the series of the charts. This module
//! computes; it never reads the clock or any I/O.

pub mod bridge;
pub mod closed;
pub mod closed_totals;
pub mod figure;
pub mod net_worth;
pub mod open;
pub mod period;
pub mod real_pnl;
pub mod returns;
pub mod series;
pub mod valued;

use binsight_core::error::AmountError;
use binsight_core::ratio::RatioError;

/// A read rule failed on arithmetic: an amount or a quotient overflowed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum ReadRuleError {
    /// An amount overflowed.
    #[error(transparent)]
    Amount(#[from] AmountError),
    /// A quotient overflowed.
    #[error(transparent)]
    Ratio(#[from] RatioError),
}
