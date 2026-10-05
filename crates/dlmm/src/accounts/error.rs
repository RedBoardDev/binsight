//! Typed failures when bytes cannot represent a supported DLMM account.

use binsight_solana::{Address, error::MalformedBytes};
use thiserror::Error;

/// An unsupported, truncated or internally inconsistent account snapshot.
#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum AccountError {
    /// A field is missing from the account bytes.
    #[error(transparent)]
    Malformed(#[from] MalformedBytes),
    /// The account uses the legacy Position layout rather than `PositionV2`.
    #[error("legacy position accounts are not supported")]
    LegacyPosition,
    /// The discriminator does not identify the expected account.
    #[error("unknown {account} account discriminator {discriminator:?}")]
    UnknownDiscriminator {
        /// The account being decoded.
        account: &'static str,
        /// The bytes encountered.
        discriminator: [u8; 8],
    },
    /// The position range cannot be represented by its supported layout.
    #[error("invalid position bin range {lower}..={upper}")]
    InvalidRange {
        /// First bin.
        lower: i32,
        /// Last bin.
        upper: i32,
    },
    /// The mint program flag has no supported token program.
    #[error("unsupported token program flag {0}")]
    UnsupportedTokenProgram(u8),
    /// A bin array belongs to another pool.
    #[error("bin array belongs to {actual}, expected {expected}")]
    WrongPool {
        /// Pool requested by the reader.
        expected: Address,
        /// Pool recorded in the account.
        actual: Address,
    },
    /// An index occurs twice in one snapshot.
    #[error("duplicate bin array index {0}")]
    DuplicateBinArray(i64),
}
