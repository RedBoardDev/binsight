//! Why a read of the portfolio failed.

use binsight_ledger::facts::PositionId;
use binsight_ledger::report::ReadRuleError;
use binsight_ledger::report::period::WindowError;
use binsight_solana::Address;

/// A read of the portfolio could not be answered.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ReadError {
    /// The source has no figures yet (the engine does not serve them yet).
    #[error("the portfolio is not ready")]
    NotReady,
    /// The read names a wallet that is not tracked.
    #[error("the wallet {0} is not tracked")]
    WalletNotFound(Address),
    /// The read names a position no tracked wallet holds or held.
    #[error("the position {0} is not tracked")]
    PositionNotFound(PositionId),
    /// The read asks for a candle size that does not fit the position's chart.
    #[error("this candle size does not fit the chart of the position")]
    InvalidInterval,
    /// No token logo is stored for the mint.
    #[error("no logo is stored for the token {0}")]
    LogoNotFound(Address),
    /// The read asks for more buckets than a chart may have.
    #[error("the chart would have more than {0} buckets")]
    TooManyBuckets(usize),
    /// A bin of a pool has no price (a bug of the source).
    #[error("the bin {bin_id} of the pool {pool} has no price")]
    BinOutOfRange {
        /// The pool.
        pool: Address,
        /// The bin.
        bin_id: i32,
    },
    /// A position refers to a fact the snapshot does not hold (a bug of the source).
    #[error("the snapshot lacks a fact a position refers to")]
    MissingFact,
    /// A read rule overflowed.
    #[error("a read rule failed")]
    Rule(#[from] ReadRuleError),
    /// A time window fell outside the supported dates.
    #[error("a time window is out of range")]
    Window(#[from] WindowError),
    /// The source's database could not be read; the source logs the cause.
    #[error("the database could not be read")]
    Database,
}

impl From<binsight_core::error::AmountError> for ReadError {
    fn from(error: binsight_core::error::AmountError) -> Self {
        Self::Rule(error.into())
    }
}

impl From<binsight_core::ratio::RatioError> for ReadError {
    fn from(error: binsight_core::ratio::RatioError) -> Self {
        Self::Rule(error.into())
    }
}
