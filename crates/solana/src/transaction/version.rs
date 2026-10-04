//! The format versions of a Solana transaction.
//!
//! A legacy transaction has no version byte; a versioned one starts its message with
//! `0x80 | version`. This module names the versions binsight can read and refuses the others; it
//! does not parse the message.

/// The newest transaction version binsight can read.
///
/// The chain client sends it as `maxSupportedTransactionVersion`, so a node never returns a
/// transaction binsight could not read.
pub const MAX_SUPPORTED_TX_VERSION: u8 = 1;

/// The format of a transaction.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum TxVersion {
    /// The original format, without a version byte.
    Legacy,
    /// Version 0: adds address lookup tables.
    V0,
    /// Version 1: up to 4096 bytes, the compute budget in the header and no lookup tables.
    V1,
}

impl TxVersion {
    /// The version number of a versioned transaction, or `None` for a legacy one.
    pub const fn number(self) -> Option<u8> {
        match self {
            Self::Legacy => None,
            Self::V0 => Some(0),
            Self::V1 => Some(1),
        }
    }
}

impl TryFrom<u8> for TxVersion {
    type Error = UnsupportedTxVersion;

    /// The versioned format with this number.
    fn try_from(number: u8) -> Result<Self, Self::Error> {
        match number {
            0 => Ok(Self::V0),
            1 => Ok(Self::V1),
            _ => Err(UnsupportedTxVersion { number }),
        }
    }
}

/// A transaction version newer than [`MAX_SUPPORTED_TX_VERSION`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
#[error(
    "transaction version {number} is not supported; the newest supported version is \
     {MAX_SUPPORTED_TX_VERSION}"
)]
pub struct UnsupportedTxVersion {
    /// The version number that was refused.
    pub number: u8,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_every_version_up_to_the_newest_supported_one() {
        for number in 0..=MAX_SUPPORTED_TX_VERSION {
            let version = TxVersion::try_from(number).unwrap();
            assert_eq!(version.number(), Some(number));
        }
        assert_eq!(TxVersion::Legacy.number(), None);
    }

    #[test]
    fn refuses_a_version_newer_than_the_newest_supported_one() {
        let error = TxVersion::try_from(2).unwrap_err();
        assert_eq!(error, UnsupportedTxVersion { number: 2 });
        assert_eq!(
            error.to_string(),
            "transaction version 2 is not supported; the newest supported version is 1"
        );
    }
}
