//! Why a transaction cannot be folded into position lives without inventing a figure.

use binsight_dlmm::math::BinMathError;
use binsight_solana::{Address, Signature};

use crate::book::BookError;
use crate::report::valued::quote::QuoteMathError;

/// A transaction the fold refused; the fold is left as it was before it.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum FoldError {
    /// The accounting rules refused the transaction.
    #[error(transparent)]
    Book(#[from] BookError),
    /// The transaction does not come after the last one folded, in `(slot, index)` order: the
    /// fold reads oldest first, each transaction once.
    #[error("the transaction {signature} does not come after the last one folded")]
    OutOfOrder {
        /// The late transaction.
        signature: Signature,
    },
    /// The node gave no index of the transaction in its block, so its place in the slot is
    /// unknown.
    #[error("the transaction {signature} has no index in its block")]
    MissingTransactionIndex {
        /// The transaction.
        signature: Signature,
    },
    /// The transaction opens, moves or closes a position of the wallet but has no block time.
    #[error("the transaction {signature} moves a position but has no block time")]
    MissingBlockTime {
        /// The transaction.
        signature: Signature,
    },
    /// A movement's pool has no supplied facts.
    #[error("no facts were supplied for the pool {pool}")]
    MissingPool {
        /// The pool.
        pool: Address,
    },
    /// A position of the wallet is created again while its life is still open.
    #[error("the position {position} is created while it is open")]
    CreatedWhileOpen {
        /// The position.
        position: Address,
    },
    /// One transaction closes a life and creates the same account again: both lives would have
    /// the same identity, the account and the creating signature.
    #[error("the position {position} is created twice by one transaction")]
    IdentityCollision {
        /// The position.
        position: Address,
    },
    /// A life of the wallet is closed by an event that names another owner.
    #[error("the position {position} of the wallet is closed for another owner")]
    ClosedByAnotherOwner {
        /// The position.
        position: Address,
    },
    /// A deposit has no booked leg in one of its pool's tokens.
    #[error("the deposit into {position} has no booked leg in {mint}")]
    MissingDepositLeg {
        /// The position.
        position: Address,
        /// The token of the missing leg.
        mint: Address,
    },
    /// A movement's bin has no valid price.
    #[error(transparent)]
    Price(#[from] BinMathError),
    /// A movement's value does not fit an exact integer.
    #[error(transparent)]
    Quote(#[from] QuoteMathError),
    /// A position total overflowed.
    #[error("a position total overflowed")]
    Overflow,
}
