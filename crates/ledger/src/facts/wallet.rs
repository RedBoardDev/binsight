//! A tracked wallet, as the accounting sees it: when it was added and how much of its history
//! is known.

use binsight_core::ratio::Percent;
use binsight_solana::Address;
use jiff::Timestamp;

/// A tracked wallet.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WalletFacts {
    /// The wallet address.
    pub address: Address,
    /// When the owner added it. Figures from before are reconstructed, hence estimated.
    pub added_at: Timestamp,
    /// How much of its history is indexed.
    pub history: HistoryCoverage,
}

/// How much of a wallet's history the accounting has read.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HistoryCoverage {
    /// Every transaction is indexed.
    Complete,
    /// The history is still being imported, newest first.
    Importing {
        /// The oldest instant indexed so far; `None` before the first page.
        indexed_since: Option<Timestamp>,
        /// How far the import is.
        progress: Percent,
    },
}

impl HistoryCoverage {
    /// Whether everything that happened from `instant` on is indexed.
    pub fn covers(self, instant: Timestamp) -> bool {
        match self {
            Self::Complete => true,
            Self::Importing { indexed_since, .. } => {
                indexed_since.is_some_and(|since| since <= instant)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_import_covers_only_what_it_has_reached() {
        let since = Timestamp::from_second(1_000).unwrap();
        let importing = HistoryCoverage::Importing {
            indexed_since: Some(since),
            progress: Percent::ZERO,
        };
        assert!(importing.covers(since));
        assert!(!importing.covers(Timestamp::from_second(999).unwrap()));
        assert!(HistoryCoverage::Complete.covers(Timestamp::UNIX_EPOCH));
        let just_started = HistoryCoverage::Importing {
            indexed_since: None,
            progress: Percent::ZERO,
        };
        assert!(!just_started.covers(since));
    }
}
