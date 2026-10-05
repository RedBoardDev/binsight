//! Adjust gross position events only with transfers proven to belong to their emitting call.
use crate::book::BookError;
use crate::book::instructions::TransferLeg;
use crate::book::positions::PositionSources;
use binsight_dlmm::{
    activity::MovementKind,
    instruction::{InstructionKind, classify, event_emitter},
    pool_tokens::PoolTokens,
};
use binsight_solana::transaction::{InstructionNode, InstructionPosition, TransactionView};

pub(super) fn adjustments(
    sources: &PositionSources<'_, '_>,
    pools: &PoolTokens,
    incoming: &[&TransferLeg],
    total_fee: u128,
) -> Result<Vec<(usize, binsight_solana::Address, u128)>, BookError> {
    let explicit = incoming.iter().try_fold(0_u128, |total, leg| {
        total.checked_add(leg.fee).ok_or(BookError::Overflow)
    })?;
    let mut adjustments = Vec::new();
    for leg in incoming {
        if !sources.tx.token_balances.iter().any(|balance| {
            balance.account == leg.source
                && balance.mint == leg.mint
                && balance.owner_pre == Some(sources.wallet)
        }) {
            continue;
        }
        let mut unproven_scope = false;
        let mut candidates =
            sources
                .activity
                .movements
                .iter()
                .enumerate()
                .filter(|(_, movement)| {
                    if !sources.owned.owns(movement.position)
                        || !matches!(
                            movement.kind,
                            MovementKind::Deposit | MovementKind::RebalanceDeposit
                        )
                        || !sources.tx.token_balances.iter().any(|balance| {
                            balance.account == leg.destination
                                && balance.mint == leg.mint
                                && balance.owner_post.or(balance.owner_pre) == Some(movement.pool)
                        })
                    {
                        return false;
                    }
                    let mints = pools.mints_of(sources.tx, movement);
                    if !((mints.x == Some(leg.mint) && movement.x.0 == leg.amount)
                        || (mints.y == Some(leg.mint) && movement.y.0 == leg.amount))
                    {
                        return false;
                    }
                    let Some(call) = call_at(sources.tx, movement.at) else {
                        unproven_scope = true;
                        return false;
                    };
                    if call.accounts.first() != Some(&movement.position) {
                        return false;
                    }
                    if let Some(inside) = contains(sources.tx, call, leg.at) {
                        inside
                    } else {
                        unproven_scope = true;
                        false
                    }
                });
        let candidate = candidates.next().map(|(index, _)| index);
        if candidates.next().is_some() || unproven_scope {
            return Err(uncertain(leg));
        }
        let Some(movement_index) = candidate else {
            continue;
        };
        let fee = if leg.fee > 0 {
            leg.fee
        } else if incoming.len() == 1 {
            total_fee
        } else if explicit == total_fee {
            0
        } else {
            return Err(uncertain(leg));
        };
        if adjustments
            .iter()
            .any(|&(index, mint, _)| index == movement_index && mint == leg.mint)
        {
            return Err(uncertain(leg));
        }
        adjustments.push((movement_index, leg.mint, fee));
    }
    Ok(adjustments)
}

fn uncertain(leg: &TransferLeg) -> BookError {
    BookError::UncertainTransferFee {
        account: leg.destination,
        mint: leg.mint,
    }
}

fn call_at(tx: &TransactionView, at: InstructionPosition) -> Option<&InstructionNode> {
    let node = tx.instructions.iter().find(|node| node.position == at)?;
    if matches!(
        classify(node),
        Some(InstructionKind::AddLiquidity | InstructionKind::Rebalance)
    ) {
        Some(node)
    } else {
        event_emitter(tx, at)
    }
}

fn contains(
    tx: &TransactionView,
    call: &InstructionNode,
    transfer: InstructionPosition,
) -> Option<bool> {
    if transfer.top != call.position.top || transfer <= call.position {
        return Some(false);
    }
    if call.position.inner.is_none() {
        return Some(transfer.inner.is_some());
    }
    let height = call.stack_height?;
    for node in tx
        .instructions
        .iter()
        .skip_while(|node| node.position <= call.position)
    {
        if node.position.top != call.position.top || node.stack_height? <= height {
            return Some(false);
        }
        if node.position == transfer {
            return Some(true);
        }
    }
    Some(false)
}
