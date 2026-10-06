//! The PnL of each liquidity position of a wallet, folded from its transactions.
//!
//! [`PositionFold`] reads one wallet's transactions oldest first. For each one it decides which
//! positions are the wallet's, books the transaction with them, then adds each of their
//! movements to the life of its position. The rules:
//!
//! 0. Transactions come in chain order, `(slot, index in the block)`, each once. A transaction
//!    without its index in the block is refused: no listing rank or block time replaces it.
//! 1. A life is one position account from its `PositionCreate` to its `PositionClose`. Its
//!    identity is the account and the creating signature; its owner is the one the creation
//!    names, whoever signed.
//! 2. A position moved without a known creation (a history that starts in the middle of its
//!    life) is the wallet's when its movement moved the wallet's own tokens; its life starts at
//!    that transaction, with only the movements seen, and is marked as missing its creation. A
//!    life open during an unknown DLMM instruction or event is marked as missing what it did.
//!    Either mark leaves the life's PnL estimated and its sign unknown.
//! 3. Every movement is valued in its own pool's quote token (SOL, then USDC, then USDT) at the
//!    active bin of its own transaction, in exact integers, with the amounts its event reports:
//!    a deposit counts what the wallet paid, a Token-2022 transfer fee withheld on the way in
//!    included; a withdrawal or a claim counts what the pool paid.
//! 4. The two halves of a rebalance count like any withdrawal and deposit.
//! 5. A movement without a bin counts its quote side only and is unpriced, and so is every
//!    movement in a pool without a supported quote token.
//! 6. A farming reward paid in the pool's quote token counts at its amount, and one paid in the
//!    pool's base token at the active bin of its own transaction (the bin of the movement of
//!    that pool nearest before it, or else after it); a reward in any other token, or without
//!    such a bin, is unpriced.
//!
//! A life's liquidity PnL (withdrawn + claimed fees + rewards − invested), its quality and its
//! outcome are read rules of [`crate::report::closed`]. This module reads no storage, network
//! or clock: the caller supplies the pools' facts.

mod error;
mod flows;
mod fold;
mod life;
mod ownership;
mod valuation;

pub use error::FoldError;
pub use flows::PositionFlows;
pub use fold::{FoldDiagnostics, FoldedTransaction, PositionFold};
pub use life::{LiveValuation, OpenLife};
