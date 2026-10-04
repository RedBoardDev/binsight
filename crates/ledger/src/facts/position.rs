//! What every liquidity position has: its identity, its strategy and the unit of its amounts.

use std::fmt;
use std::str::FromStr;

use binsight_solana::{Address, Signature};

/// The separator between the two parts of a written [`PositionId`]; it is not a base58 character.
const ID_SEPARATOR: char = '-';

/// The identity of one life of a position: its account address and the transaction that
/// created it.
///
/// The address alone is ambiguous, because a position account can be closed and created again at
/// the same address; the creating signature alone is ambiguous too, because one transaction can
/// open several positions. Together they never change and never collide. Written as
/// `<address>-<signature>`, both in base58.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct PositionId {
    /// The position account.
    pub address: Address,
    /// The transaction that created this life of the account.
    pub opened_by: Signature,
}

/// A written position id could not be read.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum PositionIdError {
    /// The text is not `<address>-<signature>` with two valid base58 values.
    #[error("a position id is a base58 address and a base58 signature joined by '-'")]
    Malformed,
}

impl fmt::Display for PositionId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "{}{ID_SEPARATOR}{}",
            self.address, self.opened_by
        )
    }
}

impl FromStr for PositionId {
    type Err = PositionIdError;

    fn from_str(text: &str) -> Result<Self, Self::Err> {
        let (address, signature) = text
            .split_once(ID_SEPARATOR)
            .ok_or(PositionIdError::Malformed)?;
        Ok(Self {
            address: address.parse().map_err(|_| PositionIdError::Malformed)?,
            opened_by: signature.parse().map_err(|_| PositionIdError::Malformed)?,
        })
    }
}

/// How a position spreads its liquidity over its bins.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Strategy {
    /// The same amount in every bin.
    Spot,
    /// More liquidity near the active bin.
    Curve,
    /// More liquidity at the edges of the range.
    BidAsk,
}

/// A signed amount in raw units of a pool's quote token: lamports for a SOL pool, micro-dollars
/// for a USDC or USDT pool.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct QuoteUnits(pub i128);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_back_what_it_writes() {
        let id = PositionId {
            address: Address::from_bytes([7; 32]),
            opened_by: Signature::from_bytes([9; 64]),
        };
        let text = id.to_string();
        assert!(text.contains('-'));
        assert_eq!(text.parse(), Ok(id));
    }

    #[test]
    fn refuses_a_lone_signature_or_garbage() {
        let signature = Signature::from_bytes([9; 64]).to_string();
        assert_eq!(
            signature.parse::<PositionId>(),
            Err(PositionIdError::Malformed)
        );
        assert_eq!(
            "abc-def".parse::<PositionId>(),
            Err(PositionIdError::Malformed)
        );
    }
}
