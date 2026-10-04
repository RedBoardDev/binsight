//! The vocabulary of the RPC credit budget: the unit, the class of a call, why it was made and
//! how it ended.
//!
//! Helius bills every request in credits and the free plan grants a fixed number per month, so
//! every call binsight makes is counted. The chain client counts, the store persists and the
//! engine plans with these same names. This module only names things and adds credits up; how
//! many credits a method costs and whether a call may be made are decided elsewhere.

mod call_outcome;
mod priority;
mod purpose;

pub use call_outcome::CallOutcome;
pub use priority::Priority;
pub use purpose::Purpose;

use std::fmt;

/// A number of RPC provider credits.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Default)]
pub struct Credits(pub u64);

impl Credits {
    /// No credit at all.
    pub const ZERO: Self = Self(0);

    /// Adds two numbers of credits, stopping at the largest value instead of overflowing.
    ///
    /// Meant for running totals compared against a limit: a total that cannot grow any more is
    /// already above every limit.
    #[must_use]
    pub fn saturating_add(self, other: Self) -> Self {
        Self(self.0.saturating_add(other.0))
    }
}

impl fmt::Display for Credits {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{} credits", self.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn displays_the_unit() {
        assert_eq!(Credits(12).to_string(), "12 credits");
    }

    #[test]
    fn stops_a_running_total_at_the_largest_value() {
        assert_eq!(
            Credits(u64::MAX).saturating_add(Credits(1)),
            Credits(u64::MAX)
        );
    }
}
