//! A ledger entry: one typed part of what a transaction changed for a wallet, in one asset.
//!
//! A transaction changes a wallet's SOL, its tokens and the rent locked in the accounts it owns.
//! [`super::book_transaction`] splits each change into entries whose kinds say why it happened,
//! and whose amounts add up, per asset, to the real change. An exchange between two assets (a
//! swap, a wrap, rent locked by the wallet) is one entry per asset, with the same kind. This
//! module defines the shapes; it does not decide which applies.

use std::fmt;

use binsight_solana::Address;

use super::residue::BridgeId;

/// One part of a wallet's change in one asset.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LedgerEntry {
    /// The asset that changed.
    pub asset: Asset,
    /// The change, in raw units of the asset (lamports for SOL and rent): positive when the
    /// wallet receives, negative when it pays.
    pub amount: i128,
    /// Why it changed.
    pub kind: EntryKind,
}

/// What a wallet holds, as the ledger counts it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Asset {
    /// The lamports of the wallet's own account.
    Sol,
    /// The lamports locked as rent in the accounts the wallet owns (its token accounts, apart
    /// from the tokens of a wrapped-SOL account, and its positions), which it gets back by closing
    /// them.
    Rent,
    /// The tokens of a mint in the wallet's token accounts (wrapped SOL included).
    Token {
        /// The mint.
        mint: Address,
    },
}

/// Why an asset of the wallet changed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EntryKind {
    /// Capital the owner put in, from outside.
    CapitalDeposit {
        /// Where it came from.
        counterparty: Counterparty,
    },
    /// Capital the owner took out.
    CapitalWithdrawal {
        /// Where it went.
        counterparty: Counterparty,
    },
    /// Tokens put into a liquidity position (a deposit, or the deposit half of a rebalance).
    PositionDeposit {
        /// The position account.
        position: Address,
    },
    /// Tokens taken out of a liquidity position (a withdrawal, or the withdrawal half of a
    /// rebalance).
    PositionWithdrawal {
        /// The position account.
        position: Address,
    },
    /// Swap fees a position paid to the wallet.
    FeeClaim {
        /// The position account.
        position: Address,
    },
    /// A farming reward a position paid to the wallet.
    RewardClaim {
        /// The position account.
        position: Address,
    },
    /// What the wallet gave in a swap. Every swap leg of one transaction belongs to one swap.
    SwapOut,
    /// What the wallet received in a swap.
    SwapIn,
    /// The signature part of the fee the wallet paid.
    NetworkFee,
    /// The priority part of the fee the wallet paid.
    PriorityFee,
    /// A tip the wallet paid to a block builder to be included.
    Tip,
    /// The whole fee of a failed transaction the wallet paid.
    FailedTxFee,
    /// Tokens withheld by a Token-2022 transfer fee on a position transfer or direct receipt.
    /// Direct capital uses gross legs so tracked counterparties cancel; the recipient books tax.
    TransferFee,
    /// Lamports the wallet locked as rent in an account: from its SOL to its rent when it owns
    /// the account, or lost when it does not (a bin array).
    RentLock {
        /// The account.
        account: Address,
        /// What the account is.
        purpose: RentPurpose,
    },
    /// Rent the wallet got back: from its rent to its SOL.
    RentRelease {
        /// The account.
        account: Address,
        /// What the account was.
        purpose: RentPurpose,
    },
    /// SOL turned into wrapped SOL.
    Wrap,
    /// Wrapped SOL turned back into SOL.
    Unwrap,
    /// Tokens the wallet destroyed (spam disposal).
    Burn,
    /// A fee paid to a known service (an account cleaner).
    ServiceFee {
        /// The service's program.
        program: Address,
    },
    /// Anything else a program did to the wallet: income, costs and airdrops of other protocols.
    /// It counts in the PnL, never as capital.
    ProtocolActivity {
        /// The first non-neutral protocol program the transaction calls, or the native token
        /// or System program responsible for an unsigned direct loss.
        program: Address,
    },
}

/// The other side of a capital move.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Counterparty {
    /// An account outside the tracked wallets; `None` when the transaction does not name exactly
    /// one.
    External {
        /// The account, when there is exactly one.
        address: Option<Address>,
    },
    /// Another wallet of this instance: both sides book the move as capital, and the aggregate
    /// view cancels them out.
    TrackedWallet(Address),
    /// A bridge to another chain.
    Bridge(BridgeId),
}

/// What an account holding rent is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum RentPurpose {
    /// A token account of the wallet.
    TokenAccount,
    /// A liquidity position of the wallet.
    Position,
    /// A bin array of a pool, paid by the wallet and not its own: its rent is not recoverable.
    BinArray,
}

impl fmt::Display for Asset {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Sol => formatter.write_str("SOL"),
            Self::Rent => formatter.write_str("rent"),
            Self::Token { mint } => write!(formatter, "token {mint}"),
        }
    }
}
