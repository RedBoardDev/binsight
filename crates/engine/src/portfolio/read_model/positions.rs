//! Reads about single positions and their tokens: a position with its chart, its movements, the
//! candles of its chart, and the token logos.

use binsight_ledger::facts::PositionId;
use binsight_solana::Address;

use crate::portfolio::answer::Answer;
use crate::portfolio::query::{EventPageRequest, IntervalChoice, PositionRequest};
use crate::portfolio::views::{CandlesView, EventPage, PositionDetailView, TokenLogoImage};

/// What the API reads about positions and their tokens.
pub trait PositionReads: Send + Sync {
    /// A position, open or closed, with its chart; found whatever the wallet filter.
    fn position(&self, request: PositionRequest) -> Answer<'_, PositionDetailView>;

    /// A page of a position's movements, newest first.
    fn position_events(&self, request: EventPageRequest) -> Answer<'_, EventPage>;

    /// The candles of a position's chart. A source that fails answers an unavailable status,
    /// never an error: the chart draws without candles.
    fn position_candles(&self, id: PositionId, interval: IntervalChoice)
    -> Answer<'_, CandlesView>;

    /// The stored logo of the token at `mint`.
    fn token_logo(&self, mint: Address) -> Answer<'_, TokenLogoImage>;
}
