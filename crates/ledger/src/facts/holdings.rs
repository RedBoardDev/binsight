//! What a wallet holds outside its positions, as last observed.

use binsight_core::units::{Lamports, RawTokenAmount};
use binsight_solana::Address;
use jiff::Timestamp;

/// The worth of a wallet outside its positions.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WalletHoldings {
    /// The wallet.
    pub wallet: Address,
    /// Free SOL and every priced token held, in lamports.
    pub idle: Lamports,
    /// Rent the owner gets back by closing accounts (positions, token accounts).
    pub recoverable_rent: Lamports,
    /// Tokens held that have no price: left out of the net worth, which is then a lower bound.
    pub unpriced: Vec<UnpricedToken>,
    /// When it was observed.
    pub observed_at: Timestamp,
}

/// A token held without a price.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct UnpricedToken {
    /// The mint.
    pub mint: Address,
    /// How much is held, in raw units.
    pub amount: RawTokenAmount,
}
