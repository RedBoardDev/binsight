//! Why a figure is not complete, on the wire.

use binsight_ledger::report::figure::Reason as LedgerReason;
use jiff::Timestamp;
use jiff::civil::Date;
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
        /// How far the import is, in percent; null when its total is unknown.
        #[schema(required = true)]
        progress: Option<DecimalString>,
    },
    /// A position movement, reward, liquidity or fee observation has an unpriced token quantity.
    UnpricedLeg {
        /// The position id.
        position: String,
    },
    /// A pool is quoted in a token that is neither SOL nor a dollar stablecoin.
    UnsupportedQuote {
        /// The pool.
        pool: String,
    },
    /// This currency conversion uses the still open UTC day’s rate.
    ProvisionalRate {
        /// The UTC day that has not closed yet.
        day: Date,
    },
    /// Open PnL is estimated from a mark before the requested historical instant.
    StaleMark {
        /// Whole seconds between the mark and the requested instant.
        age_seconds: u64,
    },
    /// Positions were open at the requested instant but no preceding valuation is known.
    MissingOpenPnlMark {
        /// The wallet whose historical open PnL is unavailable.
        wallet: String,
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
                progress: progress.map(DecimalString::from),
            },
            LedgerReason::UnpricedLeg { position } => Self::UnpricedLeg {
                position: position.to_string(),
            },
            LedgerReason::UnsupportedQuote { pool } => Self::UnsupportedQuote {
                pool: pool.to_string(),
            },
            LedgerReason::ProvisionalRate { day } => Self::ProvisionalRate { day },
            LedgerReason::StaleMark { age_seconds } => Self::StaleMark { age_seconds },
            LedgerReason::MissingOpenPnlMark { wallet } => Self::MissingOpenPnlMark {
                wallet: wallet.to_string(),
            },
            LedgerReason::NoUsdRate => Self::NoUsdRate,
            LedgerReason::ZeroDenominator => Self::ZeroDenominator,
            LedgerReason::NoLosses => Self::NoLosses,
        }
    }
}
