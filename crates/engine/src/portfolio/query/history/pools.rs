//! The pools of the history, for the pool filter: every pool a position of the scope used, with
//! how many of its positions closed and are open, searched by pair, token or address.
//!
//! They come from the owner's own history: a pool never traded would filter nothing, and the list
//! costs no call and is exact.

use std::cmp::Reverse;
use std::collections::{BTreeMap, BTreeSet};

use binsight_solana::Address;
use jiff::Timestamp;

use super::search::SearchText;
use crate::portfolio::query::check_scope;
use crate::portfolio::query::refs::pool_ref;
use crate::portfolio::read_error::ReadError;
use crate::portfolio::scope::Scope;
use crate::portfolio::snapshot::Snapshot;
use crate::portfolio::views::PoolOption;

/// The most pools one read may list.
pub const MAX_POOL_OPTIONS: usize = 50;

/// Which pools a read lists.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PoolSelection {
    /// Every pool of the history, latest close first.
    All,
    /// The pools the text names, exact symbols first.
    Search(SearchText),
    /// These pools (to name the pools a filter already holds).
    Addresses(BTreeSet<Address>),
}

/// What a read of the pools of the history asks for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PoolQuery {
    /// Whose history.
    pub scope: Scope,
    /// Which pools.
    pub selection: PoolSelection,
    /// How many at most (capped at [`MAX_POOL_OPTIONS`]).
    pub limit: usize,
}

/// How many positions of a pool closed and are open, and when the latest closed.
#[derive(Debug, Clone, Copy, Default)]
struct PoolCounts {
    closed: usize,
    open: usize,
    last_closed_at: Option<Timestamp>,
}

/// The pools of the history the query asks for. A pool's `closed_count` counts every closed
/// position of the scope in it, flat ones included: it is what History lists for that pool alone.
///
/// # Errors
///
/// Returns [`ReadError::WalletNotFound`] for an untracked wallet.
pub fn pools(snapshot: &Snapshot, query: &PoolQuery) -> Result<Vec<PoolOption>, ReadError> {
    check_scope(snapshot, query.scope)?;
    let mut counts: BTreeMap<Address, PoolCounts> = BTreeMap::new();
    for row in snapshot.closed_in(query.scope) {
        let entry = counts.entry(row.facts.pool).or_default();
        entry.closed = entry.closed.saturating_add(1);
        entry.last_closed_at = entry.last_closed_at.max(Some(row.facts.closed_at));
    }
    for row in snapshot.open_in(query.scope) {
        let entry = counts.entry(row.facts.pool).or_default();
        entry.open = entry.open.saturating_add(1);
    }
    let mut chosen: Vec<(bool, Address, PoolCounts)> = Vec::new();
    for (address, pool_counts) in counts {
        let pool = snapshot.pool(address).ok_or(ReadError::MissingFact)?;
        let (is_chosen, is_exact) = match &query.selection {
            PoolSelection::All => (true, false),
            PoolSelection::Search(search) => (search.matches_pool(pool), search.is_symbol_of(pool)),
            PoolSelection::Addresses(addresses) => (addresses.contains(&address), false),
        };
        if is_chosen {
            chosen.push((is_exact, address, pool_counts));
        }
    }
    chosen.sort_by_key(|(is_exact, address, counts)| {
        (Reverse(*is_exact), Reverse(counts.last_closed_at), *address)
    });
    chosen
        .into_iter()
        .take(query.limit.clamp(1, MAX_POOL_OPTIONS))
        .map(|(_, address, counts)| {
            Ok(PoolOption {
                pool: pool_ref(snapshot, address)?,
                closed_count: counts.closed,
                open_count: counts.open,
                last_closed_at: counts.last_closed_at,
            })
        })
        .collect()
}
