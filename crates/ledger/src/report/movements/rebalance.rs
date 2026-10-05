//! Nets each rebalance independently, without erasing its raw withdrawal and redeposit.

use std::collections::BTreeMap;

use binsight_core::error::AmountError;
use binsight_solana::Signature;
use binsight_solana::transaction::InstructionPosition;

use crate::facts::{FlowValuation, PositionEventFact, PositionEventKind, QuoteUnits};

/// The accounting contribution of one half, with the whole group's valuation quality.
#[derive(Debug, Clone, Copy, Default)]
pub(super) struct Contribution {
    /// The net contribution assigned to this half.
    pub(super) value: QuoteUnits,
    /// Whether either half left base transfers unpriced.
    pub(super) valuation: FlowValuation,
}

/// The accounting contribution of every rebalance half, assigned before any pagination.
pub(super) fn contributions(
    events: &[PositionEventFact],
) -> Result<Vec<Contribution>, AmountError> {
    let mut groups: BTreeMap<(Signature, InstructionPosition), Totals> = BTreeMap::new();
    for (index, event) in events.iter().enumerate() {
        let (movement, total) = match event.kind {
            PositionEventKind::RebalanceDeposit { movement, .. } => {
                let totals = groups
                    .entry((event.signature, movement.instruction))
                    .or_default();
                totals.first_deposit.get_or_insert(index);
                (movement, totals)
            }
            PositionEventKind::RebalanceWithdrawal(movement) => {
                let totals = groups
                    .entry((event.signature, movement.instruction))
                    .or_default();
                totals.first_withdrawal.get_or_insert(index);
                (movement, totals)
            }
            _ => continue,
        };
        let amount = match event.kind {
            PositionEventKind::RebalanceDeposit { .. } => &mut total.deposit,
            _ => &mut total.withdrawal,
        };
        amount.0 = amount
            .0
            .checked_add(movement.flow.value.0)
            .ok_or(AmountError::Overflow)?;
        total.indices.push(index);
        if movement.flow.valuation == FlowValuation::QuoteOnly {
            total.valuation = FlowValuation::QuoteOnly;
        }
    }
    let mut assigned = BTreeMap::new();
    for totals in groups.into_values() {
        let net = totals
            .deposit
            .0
            .checked_sub(totals.withdrawal.0)
            .ok_or(AmountError::Overflow)?;
        let target = if net > 0 {
            totals.first_deposit
        } else {
            totals.first_withdrawal
        };
        let amount = net.checked_abs().ok_or(AmountError::Overflow)?;
        for index in totals.indices {
            assigned.insert(
                index,
                Contribution {
                    value: QuoteUnits(if Some(index) == target { amount } else { 0 }),
                    valuation: totals.valuation,
                },
            );
        }
    }
    Ok(events
        .iter()
        .enumerate()
        .map(|(index, _)| assigned.get(&index).copied().unwrap_or_default())
        .collect())
}

#[derive(Default)]
struct Totals {
    deposit: QuoteUnits,
    withdrawal: QuoteUnits,
    first_deposit: Option<usize>,
    first_withdrawal: Option<usize>,
    indices: Vec<usize>,
    valuation: FlowValuation,
}
