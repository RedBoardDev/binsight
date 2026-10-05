//! Why a figure is not complete.

use binsight_core::ratio::Percent;
use binsight_solana::Address;
use jiff::Timestamp;
use jiff::civil::Date;

use crate::facts::PositionId;

/// One reason a figure is partial, estimated or unavailable.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Reason {
    /// A wallet holds a token without a price; the figure leaves it out.
    UnpricedToken {
        /// The wallet that holds it.
        wallet: Address,
        /// The token's mint.
        mint: Address,
    },
    /// Part of the figure comes before the wallet was added and is reconstructed.
    ReconstructedHistory {
        /// The wallet.
        wallet: Address,
        /// When it was added: what comes before is reconstructed.
        until: Timestamp,
    },
    /// A wallet's history is still being imported.
    HistoryIncomplete {
        /// The wallet.
        wallet: Address,
        /// How far the import is.
        progress: Percent,
    },
    /// A position movement or reward could not be fully valued at its own token price.
    UnpricedLeg {
        /// The position.
        position: PositionId,
    },
    /// A pool is quoted in a token that is neither SOL nor a dollar stablecoin, so its positions
    /// cannot be valued.
    UnsupportedQuote {
        /// The pool.
        pool: Address,
    },
    /// This currency conversion uses the still open UTC day’s rate.
    ProvisionalRate {
        /// The UTC day that has not closed yet.
        day: Date,
    },
    /// The last open-PnL mark precedes the requested instant while positions are open.
    StaleMark {
        /// How many seconds old the mark is.
        age_seconds: u64,
    },
    /// A wallet has historically open positions but no open-PnL mark at or before the instant.
    MissingOpenPnlMark {
        /// The wallet whose open PnL cannot be reconstructed.
        wallet: Address,
    },
    /// No SOL/USD rate is known for a day the figure needs.
    NoUsdRate,
    /// A percentage has a zero denominator.
    ZeroDenominator,
    /// A profit factor has no loss to divide by.
    NoLosses,
}
