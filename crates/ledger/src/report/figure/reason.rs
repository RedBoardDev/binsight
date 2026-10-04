//! Why a figure is not complete.

use binsight_core::ratio::Percent;
use binsight_solana::Address;
use jiff::Timestamp;

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
    /// A movement of a position had no bin price and was valued on its quote side only.
    UnpricedLeg {
        /// The position.
        position: PositionId,
    },
    /// No SOL/USD rate is known for a day the figure needs.
    NoUsdRate,
    /// A percentage has a zero denominator.
    ZeroDenominator,
    /// A profit factor has no loss to divide by.
    NoLosses,
}
