//! Derive fees on position transfers from explicit instructions or conserved gross/net receipts.
//!
//! Several withdrawals and claims can share one account. Its balance and all token instructions
//! determine the combined withheld fee; attributing it to positions requires every incoming leg
//! to be a position leg. Mixed unknown legs retain their explicit fees only.
use super::PositionSources;
mod deposits;
use crate::book::instructions::{TransferLeg, received_fee, transfers};
use crate::book::worksheet::Worksheet;
use crate::book::{Asset, BookError, EntryKind};
use binsight_solana::Address;

pub(super) struct Fees {
    entries: Vec<(Address, u128)>,
    deposit_adjustments: Vec<(usize, Address, u128)>,
}

impl Fees {
    pub(super) fn deposit_amount(
        &self,
        movement_index: usize,
        mint: Option<Address>,
        amount: u128,
    ) -> Result<u128, BookError> {
        let adjustment = self
            .deposit_adjustments
            .iter()
            .find(|&&(known, moved, _)| known == movement_index && Some(moved) == mint)
            .map_or(0, |&(_, _, fee)| fee);
        amount.checked_sub(adjustment).ok_or(BookError::Overflow)
    }
    pub(super) fn book(self, sheet: &mut Worksheet) -> Result<(), BookError> {
        for (mint, fee) in self.entries {
            let fee = i128::try_from(fee).map_err(|_| BookError::Overflow)?;
            sheet.book(
                Asset::Token { mint },
                fee.checked_neg().ok_or(BookError::Overflow)?,
                EntryKind::TransferFee,
            )?;
        }
        Ok(())
    }
}

pub(super) fn explain(
    sources: &PositionSources<'_, '_>,
    pools_tokens: &binsight_dlmm::pool_tokens::PoolTokens,
) -> Result<Fees, BookError> {
    let mut fees = Fees {
        entries: Vec::new(),
        deposit_adjustments: Vec::new(),
    };
    let pools: Vec<_> = sources
        .activity
        .movements
        .iter()
        .filter(|movement| sources.owned.owns(movement.position))
        .map(|movement| movement.pool)
        .chain(
            sources
                .activity
                .reward_claims
                .iter()
                .filter(|reward| sources.owned.owns(reward.position))
                .map(|reward| reward.pool),
        )
        .collect();
    let legs = transfers(sources.tx, sources.instructions);
    let position_legs: Vec<_> = legs
        .iter()
        .copied()
        .filter(|leg| is_position_leg(sources, &pools, *leg))
        .collect();
    let mut destinations = Vec::new();
    for leg in &position_legs {
        let key = (leg.destination, leg.mint);
        if destinations.contains(&key) {
            continue;
        }
        destinations.push(key);
        let incoming: Vec<_> = legs
            .iter()
            .filter(|candidate| {
                candidate.destination == leg.destination && candidate.mint == leg.mint
            })
            .collect();
        let are_all_position_legs = incoming
            .iter()
            .all(|leg| is_position_leg(sources, &pools, **leg));
        let fee = if are_all_position_legs {
            received_fee(sources.tx, sources.instructions, &legs, key)?
                .unwrap_or(explicit_fees(&position_legs, key)?)
        } else {
            explicit_fees(&position_legs, key)?
        };
        if fee > 0 {
            fees.entries.push((leg.mint, fee));
            for adjustment in deposits::adjustments(sources, pools_tokens, &incoming, fee)? {
                if fees
                    .deposit_adjustments
                    .iter()
                    .any(|&(index, mint, _)| index == adjustment.0 && mint == adjustment.1)
                {
                    return Err(BookError::UncertainTransferFee {
                        account: leg.destination,
                        mint: leg.mint,
                    });
                }
                fees.deposit_adjustments.push(adjustment);
            }
        }
    }
    Ok(fees)
}

fn is_position_leg(sources: &PositionSources<'_, '_>, pools: &[Address], leg: TransferLeg) -> bool {
    let owner = |account| {
        sources
            .tx
            .token_balances
            .iter()
            .find(|balance| balance.account == account && balance.mint == leg.mint)
            .and_then(|balance| balance.owner_post.or(balance.owner_pre))
    };
    matches!((owner(leg.source),owner(leg.destination)),(Some(from),Some(to))
        if (from==sources.wallet && pools.contains(&to)) || (to==sources.wallet && pools.contains(&from)))
}

fn explicit_fees(legs: &[TransferLeg], key: (Address, Address)) -> Result<u128, BookError> {
    legs.iter()
        .filter(|leg| (leg.destination, leg.mint) == key)
        .try_fold(0_u128, |total, leg| {
            total.checked_add(leg.fee).ok_or(BookError::Overflow)
        })
}
