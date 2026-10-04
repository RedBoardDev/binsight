//! The bridge: the gain over a window explained, leg by leg, by typed facts.
//!
//! Every leg is a sum of facts of the window: the PnL of the positions closed in it (marked at
//! their bins, plus the FIFO adjustment), the change of the open PnL since the window's start,
//! trading outside positions, on-chain costs, other activity, the revaluation of holdings and the
//! purchases of unpriced tokens. In SOL the legs add up to the gain exactly; a difference is a bug
//! of the facts and is reported, never absorbed. In dollars one more leg, the SOL/USD
//! revaluation, is the effect of the dollar price of SOL on what the wallets hold.

mod legs;

use binsight_core::error::AmountError;
use jiff::Timestamp;

pub use legs::{BridgeComponentKind, BridgeLegKind};

use super::closed::ClosedValuation;
use super::figure::{Combination, Figure};
use super::open::OpenValuation;
use super::period::Window;
use super::real_pnl::WalletHistory;
use super::valued::{Valued, sum_valued};
use crate::facts::{ClosedPositionFacts, OpenPositionFacts, SolUsdRates, WalletEntry};

/// What the bridge of a set of wallets is computed from.
#[derive(Debug, Clone, Copy)]
pub struct BridgeFacts<'a> {
    /// The wallets' histories (for their open-PnL marks).
    pub wallets: &'a [&'a WalletHistory],
    /// Their closed positions, valued.
    pub closed: &'a [(&'a ClosedPositionFacts, &'a ClosedValuation)],
    /// Their entries outside positions.
    pub entries: &'a [&'a WalletEntry],
    /// Their open positions, valued now.
    pub open: &'a [(&'a OpenPositionFacts, &'a OpenValuation)],
    /// The rates entries and marks are valued at.
    pub rates: &'a SolUsdRates,
}

/// The gain of a window, explained.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Bridge {
    /// The legs, in a fixed order; their sum is `total`.
    pub legs: Vec<BridgeLeg>,
    /// The gain over the window.
    pub total: Figure<Valued>,
}

/// One leg of the bridge.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BridgeLeg {
    /// Which leg.
    pub kind: BridgeLegKind,
    /// Its amount: the sum of its components, or of its facts when it has none.
    pub amount: Figure<Valued>,
    /// Its components, in a fixed order (empty for a leg that is not split).
    pub components: Vec<BridgeComponent>,
}

/// One component of a leg.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BridgeComponent {
    /// Which component.
    pub kind: BridgeComponentKind,
    /// The sum of its facts.
    pub amount: Figure<Valued>,
    /// How many facts it sums.
    pub entry_count: usize,
}

/// The bridge does not close: the facts are inconsistent.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum BridgeError {
    /// An amount overflowed.
    #[error(transparent)]
    Amount(#[from] AmountError),
    /// The legs do not add up to the gain in SOL.
    #[error("the bridge legs miss the gain by {gap} lamports")]
    DoesNotClose {
        /// The gain minus the sum of the legs, in lamports.
        gap: i128,
    },
}

/// The bridge of `gain` over `window`.
///
/// # Errors
///
/// Returns [`BridgeError::DoesNotClose`] when the legs do not add up to the gain in SOL, and
/// [`BridgeError::Amount`] when a sum overflows.
pub fn bridge(
    facts: BridgeFacts<'_>,
    window: &Window,
    gain: &Figure<Valued>,
) -> Result<Bridge, BridgeError> {
    let mut items: Vec<(BridgeLegKind, Option<BridgeComponentKind>, Figure<Valued>)> = Vec::new();
    for wallet in facts.wallets {
        let address = wallet.address();
        let mark = wallet.mark_at(window.start);
        let cutoff = mark.map_or(window.start, |mark| mark.at);
        let is_after = |at: Timestamp| at > cutoff;
        for (position, valuation) in facts.closed {
            if position.wallet == address && is_after(position.closed_at) {
                items.extend(legs::realized_items(valuation)?);
            }
        }
        for entry in facts.entries {
            if entry.wallet == address && is_after(entry.at) {
                items.extend(legs::entry_item(entry, facts.rates)?);
            }
        }
        let open_now = facts
            .open
            .iter()
            .filter(|(position, _)| position.wallet == address)
            .map(|(_, valuation)| valuation.pnl.clone());
        let open_now = sum_valued(open_now)?;
        let at_start = match mark {
            Some(mark) => Valued::of_sol(mark.open_pnl, facts.rates.on(mark.at))?,
            None => Valued::ZERO,
        };
        let at_start = Figure::Complete(at_start);
        let change = open_now.combine(at_start, Combination::Sum, Valued::try_sub)?;
        items.push((BridgeLegKind::OpenPositionsChange, None, change));
    }
    let mut legs = legs::assemble(&items)?;
    let explained = sum_valued(legs.iter().map(|leg| leg.amount.clone()))?;
    let revaluation = gain
        .clone()
        .combine(explained, Combination::Sum, Valued::try_sub)?;
    if let Some(gap) = revaluation
        .value()
        .map(|gap| gap.sol.0)
        .filter(|gap| *gap != 0)
    {
        return Err(BridgeError::DoesNotClose { gap });
    }
    legs.push(BridgeLeg {
        kind: BridgeLegKind::SolUsdRevaluation,
        amount: revaluation,
        components: Vec::new(),
    });
    Ok(Bridge {
        legs,
        total: gain.clone(),
    })
}
