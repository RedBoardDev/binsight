//! What the ledger knows about a wallet before booking one of its transactions.
//!
//! Booking is done from one wallet's point of view: its address, the other wallets of the
//! instance (a transfer to one of them is still capital, with a known counterparty) and the
//! positions it owns. A position belongs to the owner its `PositionCreate` event names, which an
//! earlier transaction may have emitted: the caller collects them. This module holds that context;
//! it does not read transactions.

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
    /// Known account-cleaning programs whose payments are service costs.
    /// The caller supplies this registry before computing real portfolio PnL.
    pub services: BTreeSet<Address>,
    /// Who paid the account rent of positions among [`Self::positions`], in an earlier
    /// transaction. Rent another account paid for a position of the wallet (an automation
    /// operating it) is that account's: it is never the wallet's asset. A position left out was
    /// created outside the history: its rent is the wallet's only when it comes back to it.
    pub position_rent: BTreeMap<Address, RentPayer>,
}

/// Who paid the account rent of a position the wallet owns.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RentPayer {
    /// The wallet: the rent is its asset until the account is closed.
    Wallet,
    /// Another account: neither its lock nor its release is the wallet's.
    Other,
}

/// The positions of the wallet in one transaction: the known ones, plus the ones the transaction
/// creates or closes with the wallet as owner.
pub(super) struct OwnedPositions<'a> {
    wallet: Address,
    known: &'a BTreeSet<Address>,
    rent_payers: &'a BTreeMap<Address, RentPayer>,
    in_transaction: Vec<Address>,
}

impl WalletContext {
    /// Starts the wallet context without previously known positions or other tracked wallets.
    pub fn new(wallet: Address) -> Self {
        Self {
            wallet,
            tracked_wallets: BTreeSet::new(),
            positions: BTreeSet::new(),
            services: BTreeSet::new(),
            position_rent: BTreeMap::new(),
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
            wallet: self.wallet,
            known: &self.positions,
            rent_payers: &self.position_rent,
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

    /// The wallet these positions belong to.
    pub(super) fn wallet(&self) -> Address {
        self.wallet
    }

    /// Who paid the rent of the position account `position` in an earlier transaction, when
    /// the history says.
    pub(super) fn rent_payer(&self, position: Address) -> Option<RentPayer> {
        self.rent_payers.get(&position).copied()
    }
}
