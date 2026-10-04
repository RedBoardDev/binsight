//! The facts the read rules work on: what the accounting knows about a wallet at one instant.
//!
//! The accounting (from the chain) and the demo world (generated) both produce these facts; every
//! figure the API shows is then computed from them by [`crate::report`], so the two sources answer
//! with the same rules. Facts are plain data: amounts are exact integers in the unit of their
//! source (the quote token of a pool, lamports for a wallet), and nothing here is converted,
//! summed or judged. This module defines the facts; it does not produce them.

mod closed;
mod entry;
mod holdings;
mod mark;
mod open;
mod pool;
mod position;
mod rates;
mod token;
mod wallet;

pub use closed::{ClosedPositionFacts, PnlMethod};
pub use entry::{WalletEntry, WalletEntryKind};
pub use holdings::{UnpricedToken, WalletHoldings};
pub use mark::OpenPnlMark;
pub use open::{BinLiquidity, OpenPositionFacts};
pub use pool::{PoolFacts, QuoteAsset};
pub use position::{PositionId, PositionIdError, QuoteUnits, Strategy};
pub use rates::SolUsdRates;
pub use token::{TokenFacts, TokenKind};
pub use wallet::{HistoryCoverage, WalletFacts};
