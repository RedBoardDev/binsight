//! Why an RPC call was made, so the credit report can say where the credits went.
//!
//! This module only names the purposes; the engine picks one for each call it makes.

use std::fmt;
use std::str::FromStr;

use crate::error::UnknownName;

/// The piece of work an RPC call belongs to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Purpose {
    /// Listing the signatures of a wallet's past, page by page.
    HistoryListing,
    /// Reading one listed transaction of the registry.
    TransactionFetch,
    /// Listing what a wallet did since its newest listed signature, after the live stream was
    /// down or a subscription started.
    TopUp,
    /// The guaranteed check: listing what a wallet did since its newest listed signature, on a
    /// schedule and after activity, in case the live stream missed something.
    LiveCheck,
    /// The live stream itself: opening it and the data it delivers.
    LiveStream,
}

impl Purpose {
    /// Every purpose.
    pub const ALL: [Self; 5] = [
        Self::HistoryListing,
        Self::TransactionFetch,
        Self::TopUp,
        Self::LiveCheck,
        Self::LiveStream,
    ];

    /// The stable `snake_case` name, as stored and shown.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::HistoryListing => "history_listing",
            Self::TransactionFetch => "transaction_fetch",
            Self::TopUp => "top_up",
            Self::LiveCheck => "live_check",
            Self::LiveStream => "live_stream",
        }
    }
}

impl FromStr for Purpose {
    type Err = UnknownName;

    /// Reads a name written by [`Purpose::as_str`].
    fn from_str(text: &str) -> Result<Self, Self::Err> {
        Self::ALL
            .into_iter()
            .find(|purpose| purpose.as_str() == text)
            .ok_or_else(|| UnknownName::new("purpose", text))
    }
}

impl fmt::Display for Purpose {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_every_purpose_through_its_name() {
        for purpose in Purpose::ALL {
            assert_eq!(purpose.as_str().parse::<Purpose>(), Ok(purpose));
        }
        assert!("everything".parse::<Purpose>().is_err());
    }
}
