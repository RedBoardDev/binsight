//! Why a figure is not complete, on the wire.

use binsight_ledger::report::figure::Reason as LedgerReason;
use jiff::Timestamp;
use serde::Serialize;
use utoipa::ToSchema;

use super::decimal::DecimalString;

/// One reason a figure is partial, estimated or unavailable, tagged by `code`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ToSchema)]
#[serde(tag = "code", rename_all = "snake_case")]
pub(crate) enum Reason {
    /// A wallet holds a token without a price; the figure leaves it out.
    UnpricedToken {
        /// The wallet that holds it.
        wallet: String,
        /// The token's mint.
        mint: String,
    },
    /// Part of the figure comes from before the wallet was added and is reconstructed.
    ReconstructedHistory {
        /// The wallet.
        wallet: String,
        /// When it was added (RFC 3339, UTC): what comes before is reconstructed.
        until: Timestamp,
    },
    /// A wallet's history is still being imported.
    HistoryIncomplete {
        /// The wallet.
        wallet: String,
        /// How far the import is, in percent.
        progress: DecimalString,
    },
    /// A movement of a position had no bin price and was valued on its quote side only.
    UnpricedLeg {
        /// The position id.
        position: String,
    },
    /// A pool is quoted in a token that is neither SOL nor a dollar stablecoin.
    UnsupportedQuote {
        /// The pool.
        pool: String,
    },
    /// No SOL/USD rate is known for a day the figure needs.
    NoUsdRate,
    /// A percentage has a zero denominator.
    ZeroDenominator,
    /// A profit factor has no loss to divide by.
    NoLosses,
}

impl From<&LedgerReason> for Reason {
    fn from(reason: &LedgerReason) -> Self {
        match *reason {
            LedgerReason::UnpricedToken { wallet, mint } => Self::UnpricedToken {
                wallet: wallet.to_string(),
                mint: mint.to_string(),
            },
            LedgerReason::ReconstructedHistory { wallet, until } => Self::ReconstructedHistory {
                wallet: wallet.to_string(),
                until,
            },
            LedgerReason::HistoryIncomplete { wallet, progress } => Self::HistoryIncomplete {
                wallet: wallet.to_string(),
                progress: progress.into(),
            },
            LedgerReason::UnpricedLeg { position } => Self::UnpricedLeg {
                position: position.to_string(),
            },
            LedgerReason::UnsupportedQuote { pool } => Self::UnsupportedQuote {
                pool: pool.to_string(),
            },
            LedgerReason::NoUsdRate => Self::NoUsdRate,
            LedgerReason::ZeroDenominator => Self::ZeroDenominator,
            LedgerReason::NoLosses => Self::NoLosses,
        }
    }
}
