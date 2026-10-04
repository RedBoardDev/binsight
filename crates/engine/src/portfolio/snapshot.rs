//! The facts of the portfolio at one instant, valued and indexed once for every read.
//!
//! A source of figures (the demo world, later the engine's projections) hands its facts over in
//! a [`SnapshotFacts`]; building the [`Snapshot`] values every position and indexes every
//! wallet's history, so the queries only filter, sort and add. A snapshot never changes; a new
//! state of the portfolio is a new snapshot.

use std::collections::BTreeMap;

use binsight_core::error::AmountError;
use binsight_ledger::facts::{
    OpenPnlMark, PoolFacts, PositionEventFact, PositionId, SolUsdRates, TokenFacts, WalletEntry,
};
use binsight_ledger::report::closed::ClosedValuation;
use binsight_ledger::report::open::OpenValuation;
use binsight_ledger::report::real_pnl::{WalletHistory, WalletHistoryFacts};
use binsight_solana::Address;

mod facts;
mod rows;

pub use facts::{SnapshotFacts, TokenLogoFacts, TrackedWallet};
pub use rows::{ClosedRow, OpenRow, PositionRow};

use super::scope::Scope;
use super::views::WalletRef;

/// The facts handed over are inconsistent.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum SnapshotError {
    /// A position refers to a pool that is not in the facts.
    #[error("a position refers to the unknown pool {0}")]
    UnknownPool(Address),
    /// An amount overflowed while valuing.
    #[error(transparent)]
    Amount(#[from] AmountError),
}

/// The portfolio at one instant, valued and indexed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Snapshot {
    wallets: Vec<TrackedWallet>,
    pools: BTreeMap<Address, PoolFacts>,
    tokens: BTreeMap<Address, TokenFacts>,
    logos: BTreeMap<Address, TokenLogoFacts>,
    closed: Vec<ClosedRow>,
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
                Ok(ClosedRow {
                    facts: position,
                    valuation,
                })
            })
            .collect::<Result<Vec<_>, SnapshotError>>()?;
        closed.sort_by(|left, right| {
            (right.facts.closed_at, right.facts.id).cmp(&(left.facts.closed_at, left.facts.id))
        });
        let open = facts
            .open
            .into_iter()
            .map(|position| {
                let valuation =
                    OpenValuation::of(&position, pool_of(position.pool)?, &facts.rates)?;
                Ok(OpenRow {
                    facts: position,
                    valuation,
                })
            })
            .collect::<Result<Vec<_>, SnapshotError>>()?;
        let histories = facts
            .wallets
            .iter()
            .map(|wallet| {
                let history =
                    wallet_history(wallet, &closed, &facts.entries, &facts.marks, &facts.rates)?;
                Ok((wallet.facts.address, history))
            })
            .collect::<Result<BTreeMap<_, _>, SnapshotError>>()?;
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
        Ok(Self {
            wallets: facts.wallets,
            pools,
            tokens,
            logos,
            closed,
            open,
            events: events_by_position(facts.events),
            entries: facts.entries,
            histories,
            rates: facts.rates,
        })
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

    /// The movements of the position `id`, oldest first (by instant, then within a
    /// transaction).
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
        group.sort_by_key(|event| (event.at, event.kind));
    }
    grouped
}

/// Indexes the history of `wallet`.
fn wallet_history(
    wallet: &TrackedWallet,
    closed: &[ClosedRow],
    entries: &[WalletEntry],
    marks: &[OpenPnlMark],
    rates: &SolUsdRates,
) -> Result<WalletHistory, AmountError> {
    let address = wallet.facts.address;
    let closed: Vec<_> = closed
        .iter()
        .filter(|row| row.facts.wallet == address)
        .map(|row| (&row.facts, &row.valuation))
        .collect();
    let entries: Vec<&WalletEntry> = entries
        .iter()
        .filter(|entry| entry.wallet == address)
        .collect();
    let marks: Vec<OpenPnlMark> = marks
        .iter()
        .filter(|mark| mark.wallet == address)
        .copied()
        .collect();
    WalletHistory::new(WalletHistoryFacts {
        wallet: &wallet.facts,
        closed: &closed,
        entries: &entries,
        marks: &marks,
        rates,
    })
}
