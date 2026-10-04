//! An open-PnL mark: what a wallet's open positions had gained or lost at one instant.

use binsight_core::money::SignedLamports;
use binsight_solana::Address;
use jiff::Timestamp;

/// The total open PnL of a wallet's positions at one instant, in SOL.
///
/// Marks are taken regularly (hourly); the real PnL of a past instant is read at the last mark at
/// or before it, together with everything realized up to that mark.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct OpenPnlMark {
    /// The wallet.
    pub wallet: Address,
    /// The instant of the mark.
    pub at: Timestamp,
    /// The sum of the open PnL of the positions open at that instant, in lamports.
    pub open_pnl: SignedLamports,
}
