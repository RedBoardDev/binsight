//! The facts of the portfolio at one instant, valued and indexed once for every read.
//!
//! A source of figures (the demo world, later the engine's projections) hands its facts over in
//! a [`SnapshotFacts`]; building the [`Snapshot`] values every position and indexes every
//! wallet's history, so the queries only filter, sort and add. A snapshot never changes; a new
//! state of the portfolio is a new snapshot.

use std::collections::BTreeMap;

use binsight_core::error::AmountError;
use binsight_core::ratio::RatioError;
use binsight_ledger::facts::{
    PoolFacts, PositionEventFact, PositionId, SolUsdRates, TokenFacts, WalletEntry,
};
use binsight_ledger::report::closed::ClosedValuation;
use binsight_ledger::report::open::OpenValuation;
use binsight_ledger::report::period::Window;
use binsight_ledger::report::real_pnl::WalletHistory;
use binsight_ledger::report::valued::Currency;
use binsight_solana::Address;

mod closed_index;
mod facts;
mod history;
mod rows;

pub use facts::{SnapshotFacts, TokenLogoFacts, TrackedWallet};
pub use rows::{ClosedRow, OpenRow, PositionRow};

use super::query::{ClosedSort, SortOrder};
use super::scope::Scope;
use super::views::ClosedKey;
use super::views::WalletRef;
use closed_index::ClosedIndex;

/// The facts handed over are inconsistent.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum SnapshotError {
    /// A position refers to a pool that is not in the facts.
    #[error("a position refers to the unknown pool {0}")]
    UnknownPool(Address),
    /// An amount overflowed while valuing.
    #[error(transparent)]
    Amount(#[from] AmountError),
    /// A return sort key overflowed while indexing.
    #[error(transparent)]
    Ratio(#[from] RatioError),
}

/// The portfolio at one instant, valued and indexed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Snapshot {
    wallets: Vec<TrackedWallet>,
    pools: BTreeMap<Address, PoolFacts>,
    tokens: BTreeMap<Address, TokenFacts>,
    logos: BTreeMap<Address, TokenLogoFacts>,
    closed: Vec<ClosedRow>,
    closed_index: ClosedIndex,
    open: Vec<OpenRow>,
    events: BTreeMap<PositionId, Vec<PositionEventFact>>,
    entries: Vec<WalletEntry>,
    histories: BTreeMap<Address, WalletHistory>,
    rates: SolUsdRates,
}

impl Snapshot {
    /// Values and indexes `facts`. Closed positions are kept from the latest close to the oldest.
    ///
    /// # Errors
    ///
    /// Returns [`SnapshotError`] when a position refers to an unknown pool or an amount
    /// overflows.
    pub fn new(facts: SnapshotFacts) -> Result<Self, SnapshotError> {
        let pools: BTreeMap<Address, PoolFacts> = facts
            .pools
            .into_iter()
            .map(|pool| (pool.address, pool))
            .collect();
        let pool_of = |address: Address| {
            pools
                .get(&address)
                .ok_or(SnapshotError::UnknownPool(address))
        };
        let mut closed = facts
            .closed
            .into_iter()
            .map(|position| {
                let valuation =
                    ClosedValuation::of(&position, pool_of(position.pool)?, &facts.rates)?;
                ClosedRow::new(position, valuation).map_err(SnapshotError::from)
            })
            .collect::<Result<Vec<_>, SnapshotError>>()?;
        closed.sort_by(|left, right| {
            (right.facts.closed_at, right.facts.id).cmp(&(left.facts.closed_at, left.facts.id))
        });
        let closed_index = ClosedIndex::new(&closed);
        let open = facts
            .open
            .into_iter()
            .map(|position| {
                let mut valuation =
                    OpenValuation::of(&position, pool_of(position.pool)?, &facts.rates)?;
                if let Some(wallet) = facts
                    .wallets
                    .iter()
                    .find(|wallet| wallet.facts.address == position.wallet)
                {
                    valuation = valuation.with_history(&wallet.facts);
                }
                Ok(OpenRow {
                    facts: position,
                    valuation,
                })
            })
            .collect::<Result<Vec<_>, SnapshotError>>()?;
        let tokens = pools
            .values()
            .flat_map(|pool| [pool.base.clone(), pool.quote.clone()])
            .chain(facts.tokens)
            .map(|token| (token.mint, token))
            .collect();
        let logos = facts
            .logos
            .into_iter()
            .map(|logo| (logo.mint, logo))
            .collect();
        let mut snapshot = Self {
            wallets: facts.wallets,
            pools,
            tokens,
            logos,
            closed,
            closed_index,
            open,
            events: events_by_position(facts.events),
            entries: facts.entries,
            histories: BTreeMap::new(),
            rates: facts.rates,
        };
        snapshot.histories = snapshot
            .wallets
            .iter()
            .map(|wallet| {
                let history = history::wallet_history(wallet, &snapshot, &facts.marks)?;
                Ok((wallet.facts.address, history))
            })
            .collect::<Result<BTreeMap<_, _>, SnapshotError>>()?;
        Ok(snapshot)
    }

    /// The tracked wallets, in the order they were added.
    pub fn wallets(&self) -> &[TrackedWallet] {
        &self.wallets
    }

    /// The tracked wallet at `address`, if any.
    pub fn wallet(&self, address: Address) -> Option<&TrackedWallet> {
        self.wallets
            .iter()
            .find(|wallet| wallet.facts.address == address)
    }

    /// How the screens name the wallet at `address`, if it is tracked.
    pub fn wallet_ref(&self, address: Address) -> Option<WalletRef> {
        self.wallet(address).map(|wallet| WalletRef {
            address,
            label: wallet.label.clone(),
            color: wallet.color,
        })
    }

    /// The tracked wallets in `scope`.
    pub fn wallets_in(&self, scope: Scope) -> impl Iterator<Item = &TrackedWallet> {
        self.wallets
            .iter()
            .filter(move |wallet| scope.includes(wallet.facts.address))
    }

    /// The pool at `address`, if a position used it.
    pub fn pool(&self, address: Address) -> Option<&PoolFacts> {
        self.pools.get(&address)
    }

    /// The token at `mint`, if it is known.
    pub fn token(&self, mint: Address) -> Option<&TokenFacts> {
        self.tokens.get(&mint)
    }

    /// The logo of the token at `mint`, if binsight stores one.
    pub fn logo(&self, mint: Address) -> Option<&TokenLogoFacts> {
        self.logos.get(&mint)
    }

    /// The closed positions of `scope`, latest close first.
    pub fn closed_in(&self, scope: Scope) -> impl Iterator<Item = &ClosedRow> {
        self.closed
            .iter()
            .filter(move |row| scope.includes(row.facts.wallet))
    }

    /// The closed positions in a precomputed order; keys are independent of scope and timezone.
    pub(crate) fn sorted_closed(
        &self,
        sort: ClosedSort,
        currency: Currency,
        order: SortOrder,
    ) -> impl Iterator<Item = (&ClosedRow, ClosedKey)> {
        self.closed_index.rows(&self.closed, sort, currency, order)
    }

    /// The closes within an instant window, found through the closing-time index.
    pub(crate) fn closed_during(&self, window: &Window) -> impl Iterator<Item = &ClosedRow> {
        let start = self
            .closed
            .partition_point(|row| row.facts.closed_at >= window.end);
        let end = self
            .closed
            .partition_point(|row| row.facts.closed_at >= window.start);
        self.closed
            .iter()
            .skip(start)
            .take(end.saturating_sub(start))
    }

    /// The open positions of `scope`.
    pub fn open_in(&self, scope: Scope) -> impl Iterator<Item = &OpenRow> {
        self.open
            .iter()
            .filter(move |row| scope.includes(row.facts.wallet))
    }

    /// The position `id`, open or closed, if a tracked wallet holds or held it.
    pub fn position(&self, id: PositionId) -> Option<PositionRow<'_>> {
        let open = self.open.iter().find(|row| row.facts.id == id);
        let closed = || self.closed.iter().find(|row| row.facts.id == id);
        open.map(PositionRow::Open)
            .or_else(|| closed().map(PositionRow::Closed))
    }

    /// The movements of the position `id`, oldest first (see
    /// [`PositionEventFact::sort_key`]).
    pub fn events_of(&self, id: PositionId) -> &[PositionEventFact] {
        self.events.get(&id).map_or(&[], Vec::as_slice)
    }

    /// The wallet entries of `scope`.
    pub fn entries_in(&self, scope: Scope) -> impl Iterator<Item = &WalletEntry> {
        self.entries
            .iter()
            .filter(move |entry| scope.includes(entry.wallet))
    }

    /// The histories of the wallets of `scope`.
    pub fn histories_in(&self, scope: Scope) -> Vec<&WalletHistory> {
        self.histories
            .iter()
            .filter(|(address, _)| scope.includes(**address))
            .map(|(_, history)| history)
            .collect()
    }

    /// The SOL/USD rates.
    pub fn rates(&self) -> &SolUsdRates {
        &self.rates
    }
}

/// The movements grouped by position, each group oldest first.
fn events_by_position(
    events: Vec<PositionEventFact>,
) -> BTreeMap<PositionId, Vec<PositionEventFact>> {
    let mut grouped: BTreeMap<PositionId, Vec<PositionEventFact>> = BTreeMap::new();
    for event in events {
        grouped.entry(event.position).or_default().push(event);
    }
    for group in grouped.values_mut() {
        group.sort_by_key(PositionEventFact::sort_key);
    }
    grouped
}
