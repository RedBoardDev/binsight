//! A wallet entry: a change of the wallet's worth outside its liquidity positions, in SOL.
//!
//! Capital moves (deposits and withdrawals by the owner) change the net worth without being a
//! gain; every other kind is part of the real PnL. Each kind is one component of the bridge
//! that explains the real PnL, so a kind is never a catch-all.

use binsight_core::money::SignedLamports;
use binsight_solana::{Address, Signature};
use jiff::Timestamp;

/// A change of a wallet's worth outside its positions, as a signed SOL amount (positive when the
/// wallet gains).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WalletEntry {
    /// The wallet it belongs to.
    pub wallet: Address,
    /// When it happened.
    pub at: Timestamp,
    /// What it is.
    pub kind: WalletEntryKind,
    /// The change, in lamports: positive for a gain or a deposit, negative for a cost or a
    /// withdrawal.
    pub amount: SignedLamports,
    /// The transaction it comes from, if one transaction explains it.
    pub signature: Option<Signature>,
}

/// What a wallet entry is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum WalletEntryKind {
    /// The owner put capital in (a transfer from outside).
    CapitalDeposit,
    /// The owner took capital out (a transfer to outside).
    CapitalWithdrawal,
    /// A gain or loss from trading tokens never deposited in a position.
    PureTrading,
    /// A gain or loss from selling, after the close, tokens withdrawn from a position.
    PostCloseTrading,
    /// The base fee of a transaction.
    NetworkFee,
    /// The priority fee of a transaction.
    PriorityFee,
    /// A tip to a block builder.
    Tip,
    /// The fee of a transaction that failed.
    FailedTransaction,
    /// A fee withheld by a token on transfer.
    TransferFee,
    /// Rent locked in an account that can never be closed.
    LostRent,
    /// A fee paid to a service (a cleaner, a bot).
    ServiceFee,
    /// Any other on-chain activity that changes the worth (rewards outside positions, airdrops,
    /// other protocols).
    OtherActivity,
    /// The change of value of tokens held outside positions.
    HoldingsRevaluation,
    /// The cost of a token bought that has no price: it leaves the net worth.
    UnvaluedPurchase,
}

impl WalletEntryKind {
    /// Whether the entry moves capital (in or out) rather than gaining or losing.
    pub fn is_capital(self) -> bool {
        matches!(self, Self::CapitalDeposit | Self::CapitalWithdrawal)
    }
}
