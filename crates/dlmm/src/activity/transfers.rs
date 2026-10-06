//! The token transfers a DLMM instruction made.
//!
//! The program pays and collects tokens by calling the token program from the instruction that
//! does the work, so those transfers sit right after it, deeper in the call stack. They name the
//! token accounts on each side, which the events do not: the ledger reads them to tell whose
//! tokens a movement moved, and the mint of a reward a rebalance harvested is read from them.
//! This module lists the transfers and finds that mint; it does not decide what they mean.

use binsight_core::units::RawTokenAmount;
use binsight_solana::Address;
use binsight_solana::programs::{self, ProgramInstruction, TokenInstruction};
use binsight_solana::transaction::{InstructionNode, InstructionPosition, TransactionView};

use super::emitter::emitter;
use crate::instruction::REBALANCE_RESERVE_ACCOUNTS;

/// One token transfer made by a DLMM instruction.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TokenTransfer {
    /// The token account that sent.
    pub source: Address,
    /// The token account that received.
    pub destination: Address,
    /// The mint, named by the transfer or by a balance of the transaction.
    pub mint: Option<Address>,
    /// The amount sent.
    pub amount: RawTokenAmount,
}

/// The token transfers made by the DLMM instruction that emitted the event at `at`, in order.
/// Empty when that instruction cannot be told (a transaction without stack heights).
pub fn emitter_transfers(tx: &TransactionView, at: InstructionPosition) -> Vec<TokenTransfer> {
    let Some(caller) = emitter(tx, at) else {
        return Vec::new();
    };
    let Some(caller_height) = caller.stack_height else {
        return Vec::new();
    };
    tx.instructions
        .iter()
        .skip_while(|node| node.position <= caller.position)
        .take_while(|node| {
            node.position.top == caller.position.top
                && node
                    .stack_height
                    .is_some_and(|height| height > caller_height)
        })
        .filter_map(|node| token_transfer(tx, node))
        .collect()
}

/// The mint of a reward of `amount` harvested by the rebalance that emitted the event at `at`.
///
/// The rebalance does not name it, but it pays it: the mint is the one its transfers of exactly
/// `amount` carry, leaving neither from nor into one of the pool's reserves (those pay the fees
/// and receive the deposits). `None` when no transfer, or transfers of two mints, match.
pub(super) fn harvested_reward_mint(
    tx: &TransactionView,
    at: InstructionPosition,
    amount: RawTokenAmount,
) -> Option<Address> {
    let rebalance = emitter(tx, at)?;
    let reserves: Vec<Address> = REBALANCE_RESERVE_ACCOUNTS
        .iter()
        .filter_map(|&index| rebalance.accounts.get(index).copied())
        .collect();
    let mut mints = emitter_transfers(tx, at)
        .into_iter()
        .filter(|transfer| {
            transfer.amount == amount
                && !reserves.contains(&transfer.source)
                && !reserves.contains(&transfer.destination)
        })
        .map(|transfer| transfer.mint);
    let first = mints.next().flatten()?;
    mints.all(|mint| mint == Some(first)).then_some(first)
}

/// The transfer `node` makes, if it is a token transfer. A malformed token instruction gives
/// none here: the ledger decodes every instruction again and reports it.
fn token_transfer(tx: &TransactionView, node: &InstructionNode) -> Option<TokenTransfer> {
    let Ok(Some(ProgramInstruction::Token { instruction, .. })) = programs::decode(node) else {
        return None;
    };
    match instruction {
        TokenInstruction::Transfer {
            source,
            destination,
            amount,
            ..
        } => Some(TokenTransfer {
            source,
            destination,
            mint: mint_held_by(tx, source).or_else(|| mint_held_by(tx, destination)),
            amount,
        }),
        TokenInstruction::TransferChecked(transfer)
        | TokenInstruction::TransferCheckedWithFee { transfer, .. } => Some(TokenTransfer {
            source: transfer.source,
            destination: transfer.destination,
            mint: Some(transfer.mint),
            amount: transfer.amount,
        }),
        _ => None,
    }
}

/// The mint of the token account `account`, from the balances of the transaction.
fn mint_held_by(tx: &TransactionView, account: Address) -> Option<Address> {
    tx.token_balances
        .iter()
        .find(|balance| balance.account == account)
        .map(|balance| balance.mint)
}
