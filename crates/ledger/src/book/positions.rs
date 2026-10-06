//! Book position movements in their real mints; no price or quote conversion belongs here.
use super::context::OwnedPositions;
use super::worksheet::Worksheet;
use super::{Asset, BookError, EntryKind, PositionActivitySource};
mod transfer_fee;

use super::instructions::{Decoded, wallet_token_accounts};
use binsight_dlmm::activity::{MovementKind, TxActivity, emitter_transfers};
use binsight_dlmm::pool_tokens::PoolTokens;
use binsight_solana::transaction::InstructionPosition;
use binsight_solana::{Address, transaction::TransactionView};

#[derive(Clone, Copy)]
pub(super) struct PositionSources<'a, 'wallet> {
    pub(super) wallet: Address,
    pub(super) tx: &'a TransactionView,
    pub(super) activity: &'a TxActivity,
    pub(super) owned: &'a OwnedPositions<'wallet>,
    pub(super) instructions: &'a Decoded,
}

pub(super) fn book(
    sources: PositionSources<'_, '_>,
    sheet: &mut Worksheet,
) -> Result<(), BookError> {
    let PositionSources {
        tx,
        activity,
        owned,
        ..
    } = sources;
    let pools = PoolTokens::of(tx);
    let fees = transfer_fee::explain(&sources, &pools)?;
    for (movement_index, movement) in activity.movements.iter().enumerate() {
        if !owned.owns(movement.position) {
            continue;
        }
        let mints = pools.mints_of(tx, movement);
        let (sign, kind) = match movement.kind {
            MovementKind::Deposit | MovementKind::RebalanceDeposit => (
                -1,
                EntryKind::PositionDeposit {
                    position: movement.position,
                },
            ),
            MovementKind::Withdrawal | MovementKind::RebalanceWithdrawal => (
                1,
                EntryKind::PositionWithdrawal {
                    position: movement.position,
                },
            ),
            MovementKind::FeeClaim => (
                1,
                EntryKind::FeeClaim {
                    position: movement.position,
                },
            ),
        };
        add(
            sheet,
            MovementLeg {
                mint: mints.x,
                original_amount: movement.x.0,
                amount: if sign < 0 {
                    fees.deposit_amount(movement_index, mints.x, movement.x.0)?
                } else {
                    movement.x.0
                },
                sign,
                kind,
                source: PositionActivitySource::Movement {
                    index: movement_index,
                    at: movement.at,
                },
                position: movement.position,
            },
        )?;
        add(
            sheet,
            MovementLeg {
                mint: mints.y,
                original_amount: movement.y.0,
                amount: if sign < 0 {
                    fees.deposit_amount(movement_index, mints.y, movement.y.0)?
                } else {
                    movement.y.0
                },
                sign,
                kind,
                source: PositionActivitySource::Movement {
                    index: movement_index,
                    at: movement.at,
                },
                position: movement.position,
            },
        )?;
    }
    for (index, reward) in activity.reward_claims.iter().enumerate() {
        if owned.owns(reward.position) {
            add(
                sheet,
                MovementLeg {
                    mint: reward.mint,
                    original_amount: reward.amount.0,
                    amount: reward.amount.0,
                    sign: 1,
                    kind: EntryKind::RewardClaim {
                        position: reward.position,
                    },
                    position: reward.position,
                    source: PositionActivitySource::RewardClaim {
                        index,
                        at: reward.at,
                    },
                },
            )?;
        }
    }
    fees.book(sheet)
}

/// Whether the DLMM instruction that emitted the event at `at` moved tokens from or to a token
/// account of `wallet`: the movement it reports paid or took the wallet's own tokens.
pub(crate) fn moves_wallet_tokens(
    wallet: Address,
    tx: &TransactionView,
    at: InstructionPosition,
) -> bool {
    let accounts = wallet_token_accounts(wallet, tx);
    emitter_transfers(tx, at).iter().any(|transfer| {
        accounts.contains(&transfer.source) || accounts.contains(&transfer.destination)
    })
}

/// Whether a movement or reward of a position the wallet does not own moved the wallet's own
/// tokens. Such a transaction is not a swap: its tokens came from a position, not a market.
pub(super) fn moves_tokens_of_unowned_position(
    wallet: Address,
    tx: &TransactionView,
    activity: &TxActivity,
    owned: &OwnedPositions<'_>,
) -> bool {
    let movements = activity
        .movements
        .iter()
        .map(|movement| (movement.position, movement.at));
    let rewards = activity
        .reward_claims
        .iter()
        .map(|reward| (reward.position, reward.at));
    movements
        .chain(rewards)
        .any(|(position, at)| !owned.owns(position) && moves_wallet_tokens(wallet, tx, at))
}

#[derive(Clone, Copy)]
struct MovementLeg {
    mint: Option<Address>,
    amount: u128,
    original_amount: u128,
    source: PositionActivitySource,
    sign: i128,
    kind: EntryKind,
    position: Address,
}

fn add(sheet: &mut Worksheet, leg: MovementLeg) -> Result<(), BookError> {
    let MovementLeg {
        mint,
        amount,
        original_amount,
        source,
        sign,
        kind,
        position,
    } = leg;
    if original_amount == 0 {
        return Ok(());
    }
    let mint = mint.ok_or(BookError::MissingMovementMint { position })?;
    let amount = i128::try_from(amount).map_err(|_| BookError::Overflow)?;
    let signed = amount.checked_mul(sign).ok_or(BookError::Overflow)?;
    sheet.book_position(Asset::Token { mint }, signed, kind, source)
}
