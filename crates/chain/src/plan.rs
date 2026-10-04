//! The Helius plans and the limits each one comes with.
//!
//! The plan sets how many requests per second the provider accepts and how many credits a
//! billing cycle grants. This module names the plans and their published limits; how binsight
//! paces and budgets itself within them is the governor's job.

use std::fmt;
use std::str::FromStr;

use binsight_core::credits::Credits;
use binsight_core::error::UnknownName;

/// A Helius subscription plan.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum HeliusPlan {
    /// The free plan: 10 requests per second advertised, 1 million credits a month.
    Free,
    /// Developer: 50 requests per second advertised, 10 million credits a month.
    Developer,
    /// Business: 200 requests per second advertised, 100 million credits a month.
    Business,
    /// Professional: 500 requests per second advertised, 200 million credits a month.
    Professional,
}

impl HeliusPlan {
    /// Every plan.
    pub const ALL: [Self; 4] = [
        Self::Free,
        Self::Developer,
        Self::Business,
        Self::Professional,
    ];

    /// The plan's name, as configured.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Free => "free",
            Self::Developer => "developer",
            Self::Business => "business",
            Self::Professional => "professional",
        }
    }

    /// The JSON-RPC requests per second binsight sends on this plan.
    ///
    /// The free plan advertises 10, but a real import paced at an even 8 per second drew a 429
    /// on one `getTransaction` in ten, and none at 5. The paid plans are not measured yet: they
    /// get 85 % of their advertised rate.
    pub const fn requests_per_second(self) -> u32 {
        match self {
            Self::Free => 5,
            Self::Developer => 42,
            Self::Business => 170,
            Self::Professional => 425,
        }
    }

    /// The credits the plan grants per billing cycle.
    pub const fn monthly_credits(self) -> Credits {
        match self {
            Self::Free => Credits(1_000_000),
            Self::Developer => Credits(10_000_000),
            Self::Business => Credits(100_000_000),
            Self::Professional => Credits(200_000_000),
        }
    }
}

impl FromStr for HeliusPlan {
    type Err = UnknownName;

    /// Reads a plan name such as `free`.
    fn from_str(text: &str) -> Result<Self, Self::Err> {
        Self::ALL
            .into_iter()
            .find(|plan| plan.as_str() == text)
            .ok_or_else(|| UnknownName::new("Helius plan", text))
    }
}

impl fmt::Display for HeliusPlan {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_every_plan_from_its_name() {
        for plan in HeliusPlan::ALL {
            assert_eq!(plan.as_str().parse::<HeliusPlan>(), Ok(plan));
        }
        assert_eq!(
            "Free".parse::<HeliusPlan>().unwrap_err().to_string(),
            "\"Free\" is not a known Helius plan"
        );
    }
}
