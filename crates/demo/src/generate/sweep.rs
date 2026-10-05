//! Capital top-ups and the idle SOL of a wallet, from its cash flows.
//!
//! The demo world does not invent an idle balance: it follows the cash. Every deposit into a
//! position takes SOL out, every close brings the invested amount and the PnL back, every entry
//! adds or removes its amount. Where the cash would fall below a small margin, the owner tops the
//! wallet up just before. The idle SOL now is then exactly what the accounting identity leaves:
//! capital + everything gained − what sits in positions − rent, so the net worth minus the capital
//! equals the real PnL to the lamport.

use binsight_core::money::SignedLamports;
use binsight_core::units::Lamports;
use binsight_ledger::facts::{
    ClosedPositionFacts, OpenPositionFacts, WalletEntry, WalletEntryKind,
};
use binsight_ledger::report::closed::ClosedValuation;
use binsight_ledger::report::open::OpenValuation;
use binsight_solana::Address;
use jiff::{SignedDuration, Timestamp};

use crate::addresses::signature;
use crate::error::DemoError;
use crate::scenario::{IDLE_MARGIN_LAMPORTS, SOL};

/// The positions and entries of one wallet, valued.
pub(crate) struct CashFlows<'a> {
    /// The wallet.
    pub(crate) wallet: Address,
    /// Its label, for the signatures of the top-ups.
    pub(crate) label: &'a str,
    /// Its closed positions and their valuation.
    pub(crate) closed: Vec<(&'a ClosedPositionFacts, &'a ClosedValuation)>,
    /// Its open positions and their valuation.
    pub(crate) open: Vec<(&'a OpenPositionFacts, &'a OpenValuation)>,
    /// Its entries.
    pub(crate) entries: &'a [WalletEntry],
}

/// The deposits that keep the wallet's cash above the margin at every flow.
pub(crate) fn top_ups(flows: &CashFlows<'_>) -> Result<Vec<WalletEntry>, DemoError> {
    let mut moves = cash_moves(flows)?;
    moves.sort_by_key(|(at, _)| *at);
    let mut cash: i128 = 0;
    let mut deposits = Vec::new();
    for (at, amount) in moves {
        let after = cash.saturating_add(amount);
        if amount < 0 && after < IDLE_MARGIN_LAMPORTS {
            let missing = IDLE_MARGIN_LAMPORTS.saturating_sub(after);
            let whole_sol = missing / SOL;
            let deposit = whole_sol.saturating_add(3).saturating_mul(SOL);
            let label = format!("top-up:{}:{}", flows.label, deposits.len());
            deposits.push(WalletEntry {
                wallet: flows.wallet,
                at: at.checked_sub(SignedDuration::from_mins(1)).unwrap_or(at),
                kind: WalletEntryKind::CapitalDeposit,
                amount: SignedLamports(deposit),
                signature: Some(signature(&label)),
            });
            cash = after.saturating_add(deposit);
        } else {
            cash = after;
        }
    }
    Ok(deposits)
}

/// The idle SOL now: capital and gains, minus what sits in open positions and `rent`.
pub(crate) fn idle_now(flows: &CashFlows<'_>, rent: Lamports) -> Result<Lamports, DemoError> {
    let entries: i128 = flows.entries.iter().map(|entry| entry.amount.0).sum();
    let mut idle = entries;
    for (_, valuation) in &flows.closed {
        idle = idle.saturating_add(sol(&valuation.pnl)?);
    }
    for (_, valuation) in &flows.open {
        let held = sol(&valuation.value)?.saturating_add(sol(&valuation.unclaimed_fees)?);
        idle = idle
            .saturating_add(sol(&valuation.pnl)?)
            .saturating_sub(held);
    }
    let idle = idle.saturating_sub(i128::from(rent.0));
    u64::try_from(idle)
        .map(Lamports)
        .map_err(|_| DemoError::NegativeIdle)
}

/// Every move of cash: deposits into positions, their returns, and the entries.
fn cash_moves(flows: &CashFlows<'_>) -> Result<Vec<(Timestamp, i128)>, DemoError> {
    let mut moves: Vec<(Timestamp, i128)> = flows
        .entries
        .iter()
        .map(|entry| (entry.at, entry.amount.0))
        .collect();
    for (position, valuation) in &flows.closed {
        let invested = sol(&valuation.invested)?;
        moves.push((position.opened_at, invested.saturating_neg()));
        moves.push((
            position.closed_at,
            invested.saturating_add(sol(&valuation.pnl)?),
        ));
    }
    for (position, valuation) in &flows.open {
        moves.push((
            position.opened_at,
            sol(&valuation.invested)?.saturating_neg(),
        ));
    }
    Ok(moves)
}

/// The SOL side of a valued figure (the demo never builds an unavailable one).
fn sol(
    figure: &binsight_ledger::report::figure::Figure<binsight_ledger::report::valued::Valued>,
) -> Result<i128, DemoError> {
    figure
        .value()
        .and_then(|valued| valued.sol.map(|sol| sol.0))
        .ok_or(DemoError::OutOfRange)
}
