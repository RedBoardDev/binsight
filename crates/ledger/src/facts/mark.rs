//! An open-PnL mark: what a wallet's open positions had gained or lost at one instant.

use binsight_core::money::SignedLamports;
use binsight_solana::Address;
use jiff::Timestamp;

use crate::report::figure::Figure;

/// The total open PnL of a wallet's positions at one instant, in SOL.
///
/// A reader preserves the mark's quality. A mark before the requested instant is stale while
/// positions are open; realized PnL and capital still use the requested instant, not this mark.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpenPnlMark {
    /// The wallet.
    pub wallet: Address,
    /// The instant of the mark.
    pub at: Timestamp,
    /// The sum of the open PnL of the positions open at that instant, in lamports.
    pub open_pnl: Figure<SignedLamports>,
}
