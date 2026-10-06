//! Which positions are the wallet's in one transaction, decided before it is booked.

use std::collections::BTreeSet;

use binsight_dlmm::activity::{LifecycleFact, TxActivity};
use binsight_solana::Address;
use binsight_solana::transaction::TransactionView;

use super::PositionFold;
use crate::book::moves_wallet_tokens;

/// The positions `fold`'s wallet owns in `tx`: its open lives, the positions `tx` creates or
/// closes with the wallet as owner, and the positions it moves without a known creation whose
/// movement moved the wallet's own tokens.
pub(super) fn owned_positions(
    fold: &PositionFold,
    tx: &TransactionView,
    activity: &TxActivity,
) -> BTreeSet<Address> {
    let wallet = fold.context.wallet;
    let mut positions: BTreeSet<Address> = fold.open.keys().copied().collect();
    let mut created = BTreeSet::new();
    for fact in &activity.lifecycle {
        let (position, owner) = match *fact {
            LifecycleFact::Created {
                position, owner, ..
            } => {
                created.insert(position);
                (position, owner)
            }
            LifecycleFact::Closed {
                position, owner, ..
            } => (position, owner),
        };
        if owner == wallet {
            positions.insert(position);
        }
    }
    let movements = activity
        .movements
        .iter()
        .map(|movement| (movement.position, movement.at));
    let rewards = activity
        .reward_claims
        .iter()
        .map(|reward| (reward.position, reward.at));
    for (position, at) in movements.chain(rewards) {
        let is_known = positions.contains(&position)
            || fold.foreign.contains(&position)
            || created.contains(&position);
        if !is_known && moves_wallet_tokens(wallet, tx, at) {
            positions.insert(position);
        }
    }
    positions
}
