//! What the ledger knows about a wallet before booking one of its transactions.
//!
//! Booking is done from one wallet's point of view: its address, the other wallets of the
//! instance (a transfer to one of them is still capital, with a known counterparty) and the
//! positions it owns. A position belongs to the owner its `PositionCreate` event names, which an
//! earlier transaction may have emitted: the caller collects them. This module holds that context;
//! it does not read transactions.

use super::BridgeId;
use std::collections::{BTreeMap, BTreeSet};

use binsight_dlmm::activity::{LifecycleFact, TxActivity};
use binsight_solana::Address;

/// One wallet's point of view.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WalletContext {
    /// The wallet.
    pub wallet: Address,
    /// The other wallets this instance tracks.
    pub tracked_wallets: BTreeSet<Address>,
    /// The known position accounts this wallet owns during this transaction.
    /// The caller replays ownership first: an address closed and recreated for another owner
    /// must not remain here merely because this wallet owned its previous life.
    pub positions: BTreeSet<Address>,
    /// Bridge programs whose movement across the wallet boundary is external capital.
    /// The caller supplies its verified, versioned registry; an empty registry makes no guess.
    pub bridges: BTreeMap<Address, BridgeId>,
    /// Known account-cleaning programs whose payments are service costs.
    /// The caller supplies this registry before computing real portfolio PnL.
    pub services: BTreeSet<Address>,
}

/// The positions of the wallet in one transaction: the known ones, plus the ones the transaction
/// creates or closes with the wallet as owner.
pub(super) struct OwnedPositions<'a> {
    known: &'a BTreeSet<Address>,
    in_transaction: Vec<Address>,
}

impl WalletContext {
    /// Starts the wallet context without previously known positions or other tracked wallets.
    pub fn new(wallet: Address) -> Self {
        Self {
            wallet,
            tracked_wallets: BTreeSet::new(),
            positions: BTreeSet::new(),
            bridges: BTreeMap::new(),
            services: BTreeSet::new(),
        }
    }

    /// The positions the wallet owns in the transaction whose activity is `activity`.
    pub(super) fn owned_positions<'a>(&'a self, activity: &TxActivity) -> OwnedPositions<'a> {
        let in_transaction = activity
            .lifecycle
            .iter()
            .filter_map(|fact| match *fact {
                LifecycleFact::Created {
                    position, owner, ..
                }
                | LifecycleFact::Closed {
                    position, owner, ..
                } => (owner == self.wallet).then_some(position),
            })
            .collect();
        OwnedPositions {
            known: &self.positions,
            in_transaction,
        }
    }

    /// Whether `address` is another wallet of this instance.
    pub(super) fn is_tracked(&self, address: Address) -> bool {
        address != self.wallet && self.tracked_wallets.contains(&address)
    }
}

impl OwnedPositions<'_> {
    /// Whether the wallet owns the position account `position`.
    pub(super) fn owns(&self, position: Address) -> bool {
        self.in_transaction.contains(&position) || self.known.contains(&position)
    }
}
