//! Why the demo world could not be generated.

use binsight_core::error::AmountError;
use binsight_dlmm::math::BinMathError;
use binsight_engine::portfolio::SnapshotError;

/// The demo world could not be built. With the default scenario this never happens; the errors
/// exist so that a change of the scenario fails loudly instead of producing wrong figures.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum DemoError {
    /// The scenario names a pool the catalog does not have.
    #[error("the scenario names an unknown pool")]
    UnknownPool,
    /// A generated value falls outside its type or the supported dates.
    #[error("a generated value is out of range")]
    OutOfRange,
    /// A wallet's idle SOL would be negative: the top-ups are wrong.
    #[error("a wallet's idle SOL would be negative")]
    NegativeIdle,
    /// A bin price could not be computed.
    #[error(transparent)]
    BinMath(#[from] BinMathError),
    /// An amount overflowed.
    #[error(transparent)]
    Amount(#[from] AmountError),
    /// The generated facts are inconsistent.
    #[error(transparent)]
    Snapshot(#[from] SnapshotError),
}
