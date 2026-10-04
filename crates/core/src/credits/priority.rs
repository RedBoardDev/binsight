//! The class of an RPC call, which decides who waits when credits or request slots run short.
//!
//! This module names the classes and their stable text form; the rules that serve or delay each
//! class belong to the chain client's governor.

use std::fmt;
use std::str::FromStr;

use crate::error::UnknownName;

/// How urgent an RPC call is. Declared from the most to the least urgent.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Priority {
    /// Something just happened and the owner is waiting for it (a live transaction).
    Realtime,
    /// Closing a gap: listing what was missed while binsight was stopped or a wallet was added.
    CatchUp,
    /// Reading the past at a pace the budget allows.
    History,
    /// Refreshing the value of open positions; a skipped refresh only makes it older.
    Valuation,
}

impl Priority {
    /// Every class, from the most to the least urgent.
    pub const ALL: [Self; 4] = [
        Self::Realtime,
        Self::CatchUp,
        Self::History,
        Self::Valuation,
    ];

    /// The stable `snake_case` name, as stored and shown.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Realtime => "realtime",
            Self::CatchUp => "catch_up",
            Self::History => "history",
            Self::Valuation => "valuation",
        }
    }
}

impl FromStr for Priority {
    type Err = UnknownName;

    /// Reads a name written by [`Priority::as_str`].
    fn from_str(text: &str) -> Result<Self, Self::Err> {
        Self::ALL
            .into_iter()
            .find(|priority| priority.as_str() == text)
            .ok_or_else(|| UnknownName::new("priority", text))
    }
}

impl fmt::Display for Priority {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_every_class_through_its_name() {
        for priority in Priority::ALL {
            assert_eq!(priority.as_str().parse::<Priority>(), Ok(priority));
        }
    }

    #[test]
    fn refuses_an_unknown_name() {
        assert_eq!(
            "urgent".parse::<Priority>(),
            Err(UnknownName::new("priority", "urgent"))
        );
    }

    #[test]
    fn orders_the_classes_from_the_most_urgent() {
        assert!(Priority::Realtime < Priority::CatchUp);
        assert!(Priority::CatchUp < Priority::History);
        assert!(Priority::History < Priority::Valuation);
    }
}
