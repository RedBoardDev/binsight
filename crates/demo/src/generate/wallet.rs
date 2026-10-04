//! Generates one wallet of the demo world: its positions, entries, top-ups, holdings and marks.

use std::collections::BTreeMap;

use binsight_core::units::{Lamports, RawTokenAmount};
use binsight_engine::portfolio::{SnapshotFacts, TrackedWallet, WalletLabel};
use binsight_ledger::facts::{
    ClosedPositionFacts, HistoryCoverage, OpenPositionFacts, PoolFacts, SolUsdRates, UnpricedToken,
    WalletEntry, WalletFacts, WalletHoldings,
};
use binsight_ledger::report::closed::ClosedValuation;
use binsight_ledger::report::open::OpenValuation;
use binsight_solana::Address;
use jiff::{SignedDuration, Timestamp};

use super::Timeline;
use super::catalog::{Catalog, CatalogPool};
use super::closed::{ClosedPlan, closed_positions};
use super::entries::{EntryPlan, wallet_entries};
use super::instance::wallet_sync;
use super::marks::hourly_marks;
use super::open::open_position;
use super::price_path::PricePath;
use super::sweep::{CashFlows, idle_now, top_ups};
use crate::addresses::address;
use crate::error::DemoError;
use crate::scenario::{
    POSITION_RENT_LAMPORTS, TOKEN_ACCOUNT_RENT_LAMPORTS, UNPRICED_TOKEN_UNITS, WalletProfile,
};

/// How many token accounts every wallet keeps open (their rent is recoverable).
const TOKEN_ACCOUNTS: u64 = 3;

/// What every wallet is generated from.
pub(crate) struct WalletContext<'a> {
    /// The seed of the world.
    pub(crate) seed: u64,
    /// The tokens and pools.
    pub(crate) catalog: &'a Catalog,
    /// The price path of each pool, by pool key.
    pub(crate) paths: &'a BTreeMap<String, PricePath>,
    /// The instants of the world.
    pub(crate) timeline: &'a Timeline,
}

/// A wallet's positions and their valuations.
struct Positions {
    closed: Vec<ClosedPositionFacts>,
    closed_values: Vec<ClosedValuation>,
    open: Vec<OpenPositionFacts>,
    open_values: Vec<OpenValuation>,
}

impl Positions {
    /// The cash flows of these positions with `entries`.
    fn flows<'a>(
        &'a self,
        wallet: Address,
        label: &'a str,
        entries: &'a [WalletEntry],
    ) -> CashFlows<'a> {
        CashFlows {
            wallet,
            label,
            closed: self.closed.iter().zip(&self.closed_values).collect(),
            open: self.open.iter().zip(&self.open_values).collect(),
            entries,
        }
    }
}

/// Generates the wallet of `profile` and adds its facts to `facts`.
pub(crate) fn generate_wallet(
    context: &WalletContext<'_>,
    profile: &WalletProfile,
    long_tail: Vec<&CatalogPool>,
    facts: &mut SnapshotFacts,
) -> Result<(), DemoError> {
    let wallet = address(&format!("wallet:{}", profile.label));
    let first_activity = days_before(context.timeline.anchor, profile.active_days)?;
    let added_at = match profile.added_days_ago {
        Some(days) => days_before(context.timeline.anchor, days)?,
        None => first_activity,
    };
    let positions = positions(
        context,
        profile,
        (wallet, first_activity),
        long_tail,
        &facts.rates,
    )?;
    let plan = EntryPlan {
        profile,
        wallet,
        first_activity,
        closed: &positions.closed,
        open: &positions.open,
    };
    let mut entries = wallet_entries(context.seed, &plan, context.timeline);
    let deposits = top_ups(&positions.flows(wallet, profile.label, &entries))?;
    entries.extend(deposits);
    entries.sort_by_key(|entry| entry.at);
    let flows = positions.flows(wallet, profile.label, &entries);
    let holdings = holdings(context, profile, &flows, positions.open.len())?;
    facts.marks.extend(hourly_marks(
        &flows,
        first_activity,
        context.timeline.anchor,
    )?);
    facts.wallets.push(TrackedWallet {
        facts: WalletFacts {
            address: wallet,
            added_at,
            history: HistoryCoverage::Complete,
        },
        label: WalletLabel::parse(Some(profile.label), &wallet)
            .map_err(|_| DemoError::OutOfRange)?,
        color: profile.color,
        holdings,
        sync: wallet_sync(profile, &flows),
    });
    facts.entries.extend(entries);
    facts.closed.extend(positions.closed);
    facts.open.extend(positions.open);
    Ok(())
}

/// The closed and open positions of a wallet, valued.
fn positions(
    context: &WalletContext<'_>,
    profile: &WalletProfile,
    (wallet, first_activity): (Address, Timestamp),
    long_tail: Vec<&CatalogPool>,
    rates: &SolUsdRates,
) -> Result<Positions, DemoError> {
    let pools = profile
        .pools
        .iter()
        .map(|(key, weight)| Ok((context.catalog.pool(key)?, *weight)))
        .collect::<Result<Vec<_>, DemoError>>()?;
    let plan = ClosedPlan {
        profile,
        wallet,
        first_activity,
        pools,
        long_tail,
    };
    let closed = closed_positions(context.seed, &plan, context.timeline, rates)?;
    let open = profile
        .open
        .iter()
        .enumerate()
        .map(|(index, spec)| {
            let pool = context.catalog.pool(spec.pool)?;
            let path = context.paths.get(spec.pool).ok_or(DemoError::UnknownPool)?;
            open_position(
                context.seed,
                (wallet, profile.label, index),
                spec,
                (pool, path),
                context.timeline,
                rates,
            )
        })
        .collect::<Result<Vec<_>, DemoError>>()?;
    let pool_of = |address: Address| -> Result<&PoolFacts, DemoError> {
        context
            .catalog
            .pools
            .iter()
            .find(|candidate| candidate.facts.address == address)
            .map(|candidate| &candidate.facts)
            .ok_or(DemoError::UnknownPool)
    };
    let closed_values = closed
        .iter()
        .map(|position| {
            Ok(ClosedValuation::of(
                position,
                pool_of(position.pool)?,
                rates,
            )?)
        })
        .collect::<Result<Vec<_>, DemoError>>()?;
    let open_values = open
        .iter()
        .map(|position| Ok(OpenValuation::of(position, pool_of(position.pool)?, rates)?))
        .collect::<Result<Vec<_>, DemoError>>()?;
    Ok(Positions {
        closed,
        closed_values,
        open,
        open_values,
    })
}

/// What the wallet holds outside positions now.
fn holdings(
    context: &WalletContext<'_>,
    profile: &WalletProfile,
    flows: &CashFlows<'_>,
    open_count: usize,
) -> Result<WalletHoldings, DemoError> {
    let open_count = u64::try_from(open_count).unwrap_or(0);
    let rent = Lamports(
        open_count
            .saturating_mul(POSITION_RENT_LAMPORTS)
            .saturating_add(TOKEN_ACCOUNTS.saturating_mul(TOKEN_ACCOUNT_RENT_LAMPORTS)),
    );
    Ok(WalletHoldings {
        wallet: flows.wallet,
        idle: idle_now(flows, rent)?,
        recoverable_rent: rent,
        unpriced: unpriced_tokens(context.catalog, profile),
        observed_at: context.timeline.anchor,
    })
}

/// The tokens without a price the wallet holds.
fn unpriced_tokens(catalog: &Catalog, profile: &WalletProfile) -> Vec<UnpricedToken> {
    if !profile.buys_unpriced_token {
        return Vec::new();
    }
    let decimals = u32::from(catalog.unpriced_token.decimals.0);
    let amount = 10_u128
        .checked_pow(decimals)
        .and_then(|unit| unit.checked_mul(UNPRICED_TOKEN_UNITS))
        .unwrap_or(0);
    vec![UnpricedToken {
        mint: catalog.unpriced_token.mint,
        amount: RawTokenAmount(amount),
    }]
}

/// The instant `days` days before `anchor`.
fn days_before(anchor: Timestamp, days: i64) -> Result<Timestamp, DemoError> {
    anchor
        .checked_sub(SignedDuration::from_hours(days.saturating_mul(24)))
        .map_err(|_| DemoError::OutOfRange)
}
