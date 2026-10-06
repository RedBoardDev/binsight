//! Bind normalized pool movements to their transaction bin and selected raw quote.
//!
//! Each movement is valued in its own pool: a transaction that closes positions in two pools
//! is valued like two transactions. Injected pool facts come from the adapter; this boundary
//! checks their agreement with the captured transaction, not the account snapshot's owner or
//! slot. It does not resolve currencies, date facts or price third-token rewards.

use binsight_core::units::Decimals;
use binsight_dlmm::activity::PositionMovement;
use binsight_dlmm::math::{BinMathError, price_from_bin};
use binsight_dlmm::pool_tokens::PoolTokens;
use binsight_solana::{Address, programs::TokenProgram, well_known::WSOL_MINT};

use super::{BookedPositionTransaction, NormalizedPositionActivity};
use crate::book::PositionActivitySource;
use crate::facts::{PoolFacts, PositionId, QuoteConvention, TokenFacts, TokenKind};
use crate::report::valued::quote::{QuoteMathError, QuotedAmount};

/// A normalized movement with the selected raw quote amount at its own transaction bin.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SelectedPoolMovement {
    source: PositionActivitySource,
    position: PositionId,
    movement: PositionMovement,
    convention: QuoteConvention,
    quoted: QuotedAmount,
}

impl SelectedPoolMovement {
    /// Its original vector row and instruction identity, including zero-net deposits.
    pub fn source(&self) -> PositionActivitySource {
        self.source
    }

    /// The replayed lifetime, distinct from an account reused by another creation.
    pub fn position(&self) -> PositionId {
        self.position
    }

    /// Its unchanged physical X/Y amounts and transaction-bin metadata.
    pub fn movement(&self) -> &PositionMovement {
        &self.movement
    }

    /// The quote selected from its own pool; physical X/Y remain unchanged.
    pub fn convention(&self) -> QuoteConvention {
        self.convention
    }

    /// Its known selected quote amount and raw pricing coverage, before signed accounting.
    pub fn quoted(&self) -> QuotedAmount {
        self.quoted
    }
}

/// A captured book and its owned movements, each valued in the quote of its own pool.
///
/// Reward claims remain in [`Self::booked`], explicitly unpriced by this boundary. The original
/// timestamps, ordering tags, gross evidence and independent fees remain there too.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QuotedPositionTransaction {
    booked: BookedPositionTransaction,
    movements: Vec<SelectedPoolMovement>,
}

impl QuotedPositionTransaction {
    /// The exact sealed book, including normalized rewards that are not priced here.
    pub fn booked(&self) -> &BookedPositionTransaction {
        &self.booked
    }

    /// Every owned normalized pool movement, in the original vector order, not chain order.
    pub fn movements(&self) -> &[SelectedPoolMovement] {
        &self.movements
    }
}

impl BookedPositionTransaction {
    /// Consumes this book and values its normalized pool movements at their own bins, each in
    /// the quote of its own pool among `pools`.
    ///
    /// Rewards remain accessible in the sealed book, without a price inferred from a pair. Pool
    /// facts must come from the adapter's verified account and mint sources. Available
    /// transaction balances must agree on decimals and token program. Stablecoin kinds are
    /// injected facts here, not derived from canonical stablecoin mint addresses. Missing dates
    /// and wallet ordinals remain explicit and do not prevent raw quotation.
    ///
    /// # Errors
    /// Refuses a movement whose pool is not among `pools`, unresolved original movement mints,
    /// inconsistent metadata, an unsupported quote, or an invalid or overflowing raw price or
    /// amount.
    pub fn quote_pools(
        self,
        pools: &[PoolFacts],
    ) -> Result<QuotedPositionTransaction, ValuationError> {
        let tokens = PoolTokens::of(&self.source().transaction);
        let mut movements = Vec::new();
        for activity in self.activities() {
            let NormalizedPositionActivity::Movement {
                source,
                position,
                movement,
            } = *activity
            else {
                continue;
            };
            let pool = pools
                .iter()
                .find(|pool| pool.address == movement.pool)
                .ok_or(ValuationError::MissingPool {
                    pool: movement.pool,
                })?;
            check_metadata(&self, &pool.base)?;
            check_metadata(&self, &pool.quote)?;
            let convention = pool
                .quote_convention()
                .ok_or(ValuationError::UnsupportedQuote)?;
            check_mints(&self, &tokens, source, pool)?;
            let raw = movement
                .price_bin
                .map(|bin| price_from_bin(bin, pool.bin_step))
                .transpose()?;
            movements.push(SelectedPoolMovement {
                source,
                position,
                movement,
                convention,
                quoted: convention.value_raw(movement.x, movement.y, raw)?,
            });
        }
        Ok(QuotedPositionTransaction {
            booked: self,
            movements,
        })
    }
}

fn check_mints(
    booked: &BookedPositionTransaction,
    tokens: &PoolTokens,
    source: PositionActivitySource,
    pool: &PoolFacts,
) -> Result<(), ValuationError> {
    let PositionActivitySource::Movement { index, at } = source else {
        return Err(ValuationError::MissingMovementMints);
    };
    let original = booked
        .source()
        .activity
        .movements
        .get(index)
        .filter(|movement| movement.at == at)
        .ok_or(ValuationError::MissingMovementMints)?;
    // A fully taxed deposit can normalize to zero; mint evidence still comes from its gross row.
    let mints = tokens.mints_of(&booked.source().transaction, original);
    for (mint, expected, gross) in [
        (mints.x, pool.base.mint, original.x),
        (mints.y, pool.quote.mint, original.y),
    ] {
        if mint.is_some_and(|mint| mint != expected) {
            return Err(ValuationError::MetadataMismatch { mint: expected });
        }
        if gross.0 > 0 && mint.is_none() {
            return Err(ValuationError::MissingMovementMints);
        }
    }
    Ok(())
}

fn check_metadata(
    booked: &BookedPositionTransaction,
    token: &TokenFacts,
) -> Result<(), ValuationError> {
    let mismatch = || ValuationError::MetadataMismatch { mint: token.mint };
    if (token.kind == TokenKind::Sol || token.mint == WSOL_MINT)
        && (token.kind != TokenKind::Sol
            || token.mint != WSOL_MINT
            || token.decimals != Decimals(9))
    {
        return Err(mismatch());
    }
    let mut program = None;
    for balance in booked
        .source()
        .transaction
        .token_balances
        .iter()
        .filter(|balance| balance.mint == token.mint)
    {
        if balance.decimals != token.decimals
            || program.is_some_and(|previous| previous != balance.program)
            || (token.mint == WSOL_MINT && balance.program != TokenProgram::Token)
        {
            return Err(mismatch());
        }
        program = Some(balance.program);
    }
    Ok(())
}

/// A sealed movement cannot be quoted without inventing metadata or an amount.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ValuationError {
    /// An owned movement's pool has no supplied facts.
    #[error("no facts were supplied for the pool {pool}")]
    MissingPool {
        /// The movement's pool address.
        pool: Address,
    },
    /// A nonzero gross movement cannot be associated with its original physical mints.
    #[error("the original movement mints are unresolved")]
    MissingMovementMints,
    /// Physical mints, decimals, kinds or source token programs contradict the pool facts.
    #[error("the source metadata contradicts the pool facts for mint {mint}")]
    MetadataMismatch {
        /// The physical mint whose metadata is inconsistent.
        mint: Address,
    },
    /// Neither physical token supplies a supported quote convention.
    #[error("the pool has no supported quote token")]
    UnsupportedQuote,
    /// The original movement bin cannot produce a valid raw price.
    #[error(transparent)]
    Price(#[from] BinMathError),
    /// The raw quote conversion cannot fit its exact integer amount.
    #[error(transparent)]
    Quote(#[from] QuoteMathError),
}
