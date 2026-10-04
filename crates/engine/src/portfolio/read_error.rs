//! Why a read of the portfolio failed.

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
    /// A read rule overflowed.
    #[error("a read rule failed")]
    Rule(#[from] ReadRuleError),
    /// A time window fell outside the supported dates.
    #[error("a time window is out of range")]
    Window(#[from] WindowError),
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
