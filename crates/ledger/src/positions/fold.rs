//! The state of one wallet's positions between two transactions, and the call that folds one more.

mod step;

use std::collections::{BTreeMap, BTreeSet};

use binsight_dlmm::activity::TxActivity;
use binsight_solana::Address;
use binsight_solana::transaction::TransactionView;

use super::ownership::owned_positions;
use super::{FoldError, OpenLife};
use crate::book::{LedgerEntry, WalletContext, book_transaction};
use crate::facts::{ClosedPositionFacts, PoolFacts};
use step::{Sources, Step};

/// The open positions of one wallet, folded from its transactions oldest first.
///
/// The state is small and plain: the open lives, the open positions of other owners met in the
/// wallet's transactions, and the place of the last transaction. Closed lives leave it as facts.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PositionFold {
    pub(super) context: WalletContext,
    pub(super) open: BTreeMap<Address, OpenLife>,
    pub(super) foreign: BTreeSet<Address>,
    last: Option<ChainPlace>,
    diagnostics: FoldDiagnostics,
}

/// What the fold met that leaves position figures incomplete, apart from missing prices.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct FoldDiagnostics {
    /// Positions the wallet moved or closed without a creation in the history.
    pub missing_creations: u32,
    /// Transactions with a DLMM instruction or event this version does not know, folded while
    /// the wallet owned a position: what they did to it is not counted.
    pub unknown_program_activity: u32,
}

impl FoldDiagnostics {
    /// These diagnostics with `missing_creations` and `unknown_program_activity` more.
    fn add(self, missing_creations: u32, unknown_program_activity: u32) -> Result<Self, FoldError> {
        let sum = |total: u32, more: u32| total.checked_add(more).ok_or(FoldError::Overflow);
        Ok(Self {
            missing_creations: sum(self.missing_creations, missing_creations)?,
            unknown_program_activity: sum(self.unknown_program_activity, unknown_program_activity)?,
        })
    }
}

/// What folding one transaction produced.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FoldedTransaction {
    /// The transaction's entries, booked with the positions the wallet owned in it.
    pub entries: Vec<LedgerEntry>,
    /// The lives of the wallet's positions the transaction closed, in instruction order.
    pub closed: Vec<ClosedPositionFacts>,
}

/// Where a transaction sits in the chain: its slot, then its index in the block. This is the
/// only order the fold accepts; a listing rank or a block time never stands in for it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
struct ChainPlace {
    slot: u64,
    index: u32,
}

impl PositionFold {
    /// A fold with no position yet, from the point of view of `context`'s wallet. The fold sets
    /// the context's positions itself before booking each transaction.
    pub fn new(context: WalletContext) -> Self {
        Self {
            context,
            open: BTreeMap::new(),
            foreign: BTreeSet::new(),
            last: None,
            diagnostics: FoldDiagnostics::default(),
        }
    }

    /// Books `tx`, whose DLMM activity is `activity`, and adds its movements to the wallet's
    /// position lives, each valued with its own pool among `pools`.
    ///
    /// # Errors
    /// Returns a [`FoldError`] when `tx` has no index in its block, does not come after the
    /// last folded transaction in `(slot, index)` order, cannot be
    /// booked, lacks a needed block time or pool, or a value overflows. The fold is then left
    /// unchanged.
    pub fn book(
        &mut self,
        tx: &TransactionView,
        activity: &TxActivity,
        pools: &BTreeMap<Address, PoolFacts>,
    ) -> Result<FoldedTransaction, FoldError> {
        let place = self.place_of(tx)?;
        self.context.positions = owned_positions(self, tx, activity);
        let booked = book_transaction(&self.context, tx, activity);
        let owned = std::mem::take(&mut self.context.positions);
        let entries = booked?;
        let sources = Sources {
            owned: &owned,
            tx,
            activity,
            pools,
        };
        let closed = self.apply(sources, place)?;
        Ok(FoldedTransaction { entries, closed })
    }

    /// Applies the position activity of one booked transaction at `place`, all or nothing, and
    /// returns the lives it closed. A transaction without position activity changes no life.
    fn apply(
        &mut self,
        sources: Sources<'_>,
        place: ChainPlace,
    ) -> Result<Vec<ClosedPositionFacts>, FoldError> {
        let activity = sources.activity;
        let is_quiet = activity.lifecycle.is_empty()
            && activity.movements.is_empty()
            && activity.reward_claims.is_empty()
            && !activity.has_unknown_program_activity;
        if is_quiet {
            self.last = Some(place);
            return Ok(Vec::new());
        }
        let mut step = Step::new(self, sources);
        step.apply()?;
        let outcome = step.finish();
        let unknown = u32::from(activity.has_unknown_program_activity && !sources.owned.is_empty());
        let diagnostics = self.diagnostics.add(outcome.missing_creations, unknown)?;
        self.open = outcome.open;
        self.foreign = outcome.foreign;
        self.last = Some(place);
        self.diagnostics = diagnostics;
        Ok(outcome.closed)
    }

    /// The wallet's open position lives, by position account.
    pub fn open(&self) -> impl Iterator<Item = &OpenLife> {
        self.open.values()
    }

    /// The wallet whose positions are folded.
    pub fn wallet(&self) -> Address {
        self.context.wallet
    }

    /// What the fold met that leaves position figures incomplete.
    pub fn diagnostics(&self) -> FoldDiagnostics {
        self.diagnostics
    }

    /// The place of `tx`, which must come after the last folded transaction.
    fn place_of(&self, tx: &TransactionView) -> Result<ChainPlace, FoldError> {
        let index = tx
            .transaction_index
            .ok_or(FoldError::MissingTransactionIndex {
                signature: tx.signature,
            })?;
        let place = ChainPlace {
            slot: tx.slot,
            index,
        };
        if self.last.is_some_and(|last| place <= last) {
            return Err(FoldError::OutOfOrder {
                signature: tx.signature,
            });
        }
        Ok(place)
    }
}
