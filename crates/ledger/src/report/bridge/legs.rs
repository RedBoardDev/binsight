//! The legs and components of the bridge, which fact goes in which, and how they are summed.

use binsight_core::error::AmountError;

use super::{BridgeComponent, BridgeLeg};
use crate::facts::{SolUsdRates, WalletEntry, WalletEntryKind};
use crate::report::closed::ClosedValuation;
use crate::report::figure::{Combination, Figure};
use crate::report::valued::{Valued, sum_valued};

/// A leg of the bridge.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum BridgeLegKind {
    /// The PnL of the positions closed in the window.
    RealizedPositions,
    /// The change of the open PnL since the start of the window.
    OpenPositionsChange,
    /// Trading outside positions.
    OutsidePositions,
    /// Fees, tips, lost rent and other on-chain costs.
    OnchainCosts,
    /// Any other activity that changed the worth.
    OtherActivity,
    /// The change of value of tokens held outside positions.
    HoldingsRevaluation,
    /// Tokens bought that have no price.
    UnvaluedHoldings,
    /// The effect of the dollar price of SOL (zero in SOL).
    SolUsdRevaluation,
}

/// A component of a leg.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum BridgeComponentKind {
    /// Positions marked at the bins of their movements.
    PoolMarked,
    /// Rewards claimed in their own mint and priced at the claim time.
    Rewards,
    /// What the FIFO cost basis adds to the bin marks.
    FifoAdjustment,
    /// Trading tokens never deposited in a position.
    PureTrading,
    /// Selling tokens withdrawn from closed positions.
    PostCloseTrading,
    /// Base transaction fees.
    NetworkFees,
    /// Priority fees.
    PriorityFees,
    /// Tips to block builders.
    Tips,
    /// Fees of failed transactions.
    FailedTransactions,
    /// Fees withheld by tokens on transfer.
    TransferFees,
    /// Rent that can never be recovered.
    LostRent,
    /// Fees paid to services.
    ServiceFees,
}

/// The legs in the order they are shown, with their components in order.
const LAYOUT: [(BridgeLegKind, &[BridgeComponentKind]); 7] = [
    (
        BridgeLegKind::RealizedPositions,
        &[
            BridgeComponentKind::PoolMarked,
            BridgeComponentKind::Rewards,
            BridgeComponentKind::FifoAdjustment,
        ],
    ),
    (BridgeLegKind::OpenPositionsChange, &[]),
    (
        BridgeLegKind::OutsidePositions,
        &[
            BridgeComponentKind::PureTrading,
            BridgeComponentKind::PostCloseTrading,
        ],
    ),
    (
        BridgeLegKind::OnchainCosts,
        &[
            BridgeComponentKind::NetworkFees,
            BridgeComponentKind::PriorityFees,
            BridgeComponentKind::Tips,
            BridgeComponentKind::FailedTransactions,
            BridgeComponentKind::TransferFees,
            BridgeComponentKind::LostRent,
            BridgeComponentKind::ServiceFees,
        ],
    ),
    (BridgeLegKind::OtherActivity, &[]),
    (BridgeLegKind::HoldingsRevaluation, &[]),
    (BridgeLegKind::UnvaluedHoldings, &[]),
];

/// One fact of the bridge: its leg, its component (if the leg is split) and its amount.
pub(super) type BridgeItem = (BridgeLegKind, Option<BridgeComponentKind>, Figure<Valued>);

/// The two items of a closed position: its bin-marked PnL and its FIFO adjustment.
pub(super) fn realized_items(valuation: &ClosedValuation) -> Result<Vec<BridgeItem>, AmountError> {
    let adjustment = valuation.pnl.clone().combine(
        valuation.lp_pnl.clone(),
        Combination::Difference,
        Valued::try_sub,
    )?;
    let pool_marked = valuation.lp_pnl.clone().combine(
        valuation.rewards.clone(),
        Combination::Difference,
        Valued::try_sub,
    )?;
    Ok(vec![
        (
            BridgeLegKind::RealizedPositions,
            Some(BridgeComponentKind::PoolMarked),
            pool_marked,
        ),
        (
            BridgeLegKind::RealizedPositions,
            Some(BridgeComponentKind::Rewards),
            valuation.rewards.clone(),
        ),
        (
            BridgeLegKind::RealizedPositions,
            Some(BridgeComponentKind::FifoAdjustment),
            adjustment,
        ),
    ])
}

/// The item of a wallet entry, valued at the rate of its day; none for a capital move.
pub(super) fn entry_item(
    entry: &WalletEntry,
    rates: &SolUsdRates,
) -> Result<Option<BridgeItem>, AmountError> {
    let Some((leg, component)) = place(entry.kind) else {
        return Ok(None);
    };
    let amount = Figure::Complete(Valued::of_sol_at(entry.amount, rates.on(entry.at))?);
    Ok(Some((leg, component, amount)))
}

/// Sums the items into the legs of [`LAYOUT`].
pub(super) fn assemble(items: &[BridgeItem]) -> Result<Vec<BridgeLeg>, AmountError> {
    LAYOUT
        .iter()
        .map(|(leg, components)| {
            let of_leg: Vec<&BridgeItem> = items.iter().filter(|item| item.0 == *leg).collect();
            let components = components
                .iter()
                .map(|component| {
                    let facts: Vec<Figure<Valued>> = of_leg
                        .iter()
                        .filter(|item| item.1 == Some(*component))
                        .map(|item| item.2.clone())
                        .collect();
                    Ok(BridgeComponent {
                        kind: *component,
                        entry_count: facts.len(),
                        amount: sum_valued(facts)?,
                    })
                })
                .collect::<Result<Vec<_>, AmountError>>()?;
            Ok(BridgeLeg {
                kind: *leg,
                amount: sum_valued(of_leg.iter().map(|item| item.2.clone()))?,
                components,
            })
        })
        .collect()
}

/// Where an entry of `kind` goes; `None` for capital, which is not a gain.
fn place(kind: WalletEntryKind) -> Option<(BridgeLegKind, Option<BridgeComponentKind>)> {
    use BridgeComponentKind as Component;
    use BridgeLegKind as Leg;
    let placed = match kind {
        WalletEntryKind::CapitalDeposit | WalletEntryKind::CapitalWithdrawal => return None,
        WalletEntryKind::PureTrading => (Leg::OutsidePositions, Some(Component::PureTrading)),
        WalletEntryKind::PostCloseTrading => {
            (Leg::OutsidePositions, Some(Component::PostCloseTrading))
        }
        WalletEntryKind::NetworkFee => (Leg::OnchainCosts, Some(Component::NetworkFees)),
        WalletEntryKind::PriorityFee => (Leg::OnchainCosts, Some(Component::PriorityFees)),
        WalletEntryKind::Tip => (Leg::OnchainCosts, Some(Component::Tips)),
        WalletEntryKind::FailedTransaction => {
            (Leg::OnchainCosts, Some(Component::FailedTransactions))
        }
        WalletEntryKind::TransferFee => (Leg::OnchainCosts, Some(Component::TransferFees)),
        WalletEntryKind::LostRent => (Leg::OnchainCosts, Some(Component::LostRent)),
        WalletEntryKind::ServiceFee => (Leg::OnchainCosts, Some(Component::ServiceFees)),
        WalletEntryKind::OtherActivity => (Leg::OtherActivity, None),
        WalletEntryKind::HoldingsRevaluation => (Leg::HoldingsRevaluation, None),
        WalletEntryKind::UnvaluedPurchase => (Leg::UnvaluedHoldings, None),
    };
    Some(placed)
}
