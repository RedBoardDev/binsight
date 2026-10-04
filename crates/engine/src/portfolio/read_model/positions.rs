//! Reads about single positions and their tokens: the token logos.

use binsight_solana::Address;

use crate::portfolio::answer::Answer;
use crate::portfolio::views::TokenLogoImage;

/// What the API reads about positions and their tokens.
pub trait PositionReads: Send + Sync {
    /// The stored logo of the token at `mint`.
    fn token_logo(&self, mint: Address) -> Answer<'_, TokenLogoImage>;
}
