//! Book position movements in their real mints; no price or quote conversion belongs here.
use super::context::OwnedPositions;
use super::worksheet::Worksheet;
use super::{Asset, BookError, EntryKind};
mod transfer_fee;

use super::instructions::Decoded;
use binsight_dlmm::activity::{MovementKind, TxActivity};
use binsight_dlmm::pool_tokens::PoolTokens;
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
                amount: if sign < 0 {
                    fees.deposit_amount(movement_index, mints.x, movement.x.0)?
                } else {
                    movement.x.0
                },
                sign,
                kind,
                position: movement.position,
            },
        )?;
        add(
            sheet,
            MovementLeg {
                mint: mints.y,
                amount: if sign < 0 {
                    fees.deposit_amount(movement_index, mints.y, movement.y.0)?
                } else {
                    movement.y.0
                },
                sign,
                kind,
                position: movement.position,
            },
        )?;
    }
    for reward in &activity.reward_claims {
        if owned.owns(reward.position) {
            add(
                sheet,
                MovementLeg {
                    mint: reward.mint,
                    amount: reward.amount.0,
                    sign: 1,
                    kind: EntryKind::RewardClaim {
                        position: reward.position,
                    },
                    position: reward.position,
                },
            )?;
        }
    }
    fees.book(sheet)
}

#[derive(Clone, Copy)]
struct MovementLeg {
    mint: Option<Address>,
    amount: u128,
    sign: i128,
    kind: EntryKind,
    position: Address,
}

fn add(sheet: &mut Worksheet, leg: MovementLeg) -> Result<(), BookError> {
    let MovementLeg {
        mint,
        amount,
        sign,
        kind,
        position,
    } = leg;
    if amount == 0 {
        return Ok(());
    }
    let mint = mint.ok_or(BookError::MissingMovementMint { position })?;
    let amount = i128::try_from(amount).map_err(|_| BookError::Overflow)?;
    let signed = amount.checked_mul(sign).ok_or(BookError::Overflow)?;
    sheet.book(Asset::Token { mint }, signed, kind)
}
