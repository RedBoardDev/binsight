//! A position's movements as a breakdown of its figures in either currency.
//!
//! Quote-token amounts retain their transaction-bin valuation. Currency conversion uses the
//! position's rate (closing day or spot), as its header does. Converting successive cumulative
//! flows and taking their difference distributes rounding deterministically: deposits,
//! withdrawals and claims each add up exactly to their position figure, regardless of pagination.

use binsight_core::error::AmountError;

use super::figure::{Figure, Reason, Reasons};
use super::valued::{Valued, subtract_valued, value_quote_at};
use crate::facts::{
    DailyRate, FlowValuation, PositionEventFact, PositionEventKind, QuoteAsset, QuoteUnits,
};
use binsight_core::exactness::Exactness;

mod rebalance;

/// Values the movements, in their supplied chain order, at the position's rate.
/// Movements that carry no tokens have no value. The returned vector has one item per movement.
///
/// # Errors
///
/// Returns [`AmountError::Overflow`] when a cumulative amount or its conversion overflows.
pub fn value_movements(
    events: &[PositionEventFact],
    asset: QuoteAsset,
    rate: Option<DailyRate>,
) -> Result<Vec<Option<Figure<Valued>>>, AmountError> {
    let contributions = rebalance::contributions(events)?;
    let mut totals = MovementTotals::default();
    events
        .iter()
        .zip(contributions)
        .map(|(event, rebalance)| {
            let Some(amount) = contribution(event, rebalance.value) else {
                return Ok(
                    matches!(event.kind, PositionEventKind::RewardClaim(_)).then(|| {
                        Figure::unavailable(Reason::UnpricedLeg {
                            position: event.position,
                        })
                    }),
                );
            };
            let Some(total) = totals.of(&event.kind) else {
                return Ok(None);
            };
            let previous = *total;
            total.0 = previous
                .0
                .checked_add(amount.0)
                .ok_or(AmountError::Overflow)?;
            let before = value_quote_at(previous, asset, rate)?;
            let after = value_quote_at(*total, asset, rate)?;
            let value = subtract_valued(after, before)?;
            let quality = match event.kind {
                PositionEventKind::RebalanceDeposit { .. }
                | PositionEventKind::RebalanceWithdrawal(_)
                    if rebalance.valuation == FlowValuation::QuoteOnly =>
                {
                    Exactness::Estimated
                }
                _ if event
                    .kind
                    .flow()
                    .is_some_and(|flow| flow.valuation == FlowValuation::QuoteOnly) =>
                {
                    Exactness::Partial
                }
                _ => Exactness::Complete,
            };
            let reasons = if quality == Exactness::Complete {
                Reasons::new()
            } else {
                Reasons::from([Reason::UnpricedLeg {
                    position: event.position,
                }])
            };
            Ok(Some(value.degraded(quality, reasons)))
        })
        .collect()
}

fn contribution(event: &PositionEventFact, rebalance: QuoteUnits) -> Option<QuoteUnits> {
    match event.kind {
        PositionEventKind::Add(flow)
        | PositionEventKind::Remove(flow)
        | PositionEventKind::Claim(flow) => Some(flow.value),
        PositionEventKind::RebalanceDeposit { .. } | PositionEventKind::RebalanceWithdrawal(_) => {
            Some(rebalance)
        }
        PositionEventKind::RewardClaim(reward) => reward
            .value
            .or_else(|| (reward.amount.0 == 0).then_some(QuoteUnits(0))),
        PositionEventKind::Created { .. } | PositionEventKind::Closed => None,
    }
}

/// Each header figure has its own rounding boundary.
#[derive(Default)]
struct MovementTotals {
    deposits: QuoteUnits,
    withdrawals: QuoteUnits,
    claims: QuoteUnits,
    rewards: QuoteUnits,
}

impl MovementTotals {
    fn of(&mut self, kind: &PositionEventKind) -> Option<&mut QuoteUnits> {
        match kind {
            PositionEventKind::RebalanceDeposit { .. } | PositionEventKind::Add(_) => {
                Some(&mut self.deposits)
            }
            PositionEventKind::Remove(_) | PositionEventKind::RebalanceWithdrawal(_) => {
                Some(&mut self.withdrawals)
            }
            PositionEventKind::Claim(_) => Some(&mut self.claims),
            PositionEventKind::RewardClaim(_) => Some(&mut self.rewards),
            PositionEventKind::Created { .. } | PositionEventKind::Closed => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use binsight_core::units::RawTokenAmount;
    use binsight_solana::{Address, Signature};
    use jiff::Timestamp;

    use super::*;
    use crate::facts::{ChainOrder, PositionId, TokenFlow};
    use crate::report::valued::value_quote;
    use binsight_core::money::SolUsdRate;

    fn claim(index: u32) -> PositionEventFact {
        PositionEventFact {
            position: PositionId {
                address: Address::from_bytes([1; 32]),
                opened_by: Signature::from_bytes([2; 64]),
            },
            at: Timestamp::UNIX_EPOCH,
            order: ChainOrder {
                slot: 1,
                transaction_index: 0,
                event_index: index,
            },
            signature: Signature::from_bytes([2; 64]),
            active_bin_id: None,
            kind: PositionEventKind::Claim(TokenFlow {
                base: RawTokenAmount(0),
                quote: RawTokenAmount(1),
                value: QuoteUnits(1),
                valuation: FlowValuation::Complete,
            }),
        }
    }

    #[test]
    fn distributes_fractional_micro_dollars_without_losing_the_header_total() {
        let events: Vec<_> = (0..7).map(claim).collect();
        let rate = SolUsdRate::new(200_000_000).unwrap();
        let values =
            value_movements(&events, QuoteAsset::Sol, Some(DailyRate::Final(rate))).unwrap();
        let sum = values
            .into_iter()
            .flatten()
            .try_fold(Valued::ZERO, |total, figure| {
                total.try_add(*figure.value().unwrap())
            })
            .unwrap();
        let header = value_quote(QuoteUnits(7), QuoteAsset::Sol, Some(rate)).unwrap();

        assert_eq!(sum, *header.value().unwrap());
        assert_ne!(sum.usd.unwrap().0, 0);
    }

    #[test]
    fn rejects_a_cumulative_flow_overflow_instead_of_wrapping() {
        let mut first = claim(0);
        if let PositionEventKind::Claim(flow) = &mut first.kind {
            flow.value = QuoteUnits(i128::MAX);
        }
        assert_eq!(
            value_movements(&[first, claim(1)], QuoteAsset::Sol, None),
            Err(AmountError::Overflow)
        );
    }
    fn rebalance(
        index: u32,
        instruction: u16,
        deposit: i128,
        withdrawal: i128,
    ) -> [PositionEventFact; 2] {
        use crate::facts::RebalanceFlow;
        use binsight_solana::transaction::InstructionPosition;
        let half = |amount| RebalanceFlow {
            instruction: InstructionPosition {
                top: instruction,
                inner: Some(0),
            },
            flow: TokenFlow {
                base: RawTokenAmount(50),
                quote: RawTokenAmount(70),
                value: QuoteUnits(amount),
                valuation: FlowValuation::Complete,
            },
        };
        let mut removed = claim(index);
        removed.kind = PositionEventKind::RebalanceWithdrawal(half(withdrawal));
        let mut added = claim(index.checked_add(1).unwrap());
        added.kind = PositionEventKind::RebalanceDeposit {
            movement: half(deposit),
            range: None,
        };
        [removed, added]
    }

    #[test]
    fn nets_each_rebalance_in_one_transaction_before_currency_rounding() {
        let events: Vec<_> = [
            rebalance(0, 0, 100, 100),
            rebalance(2, 1, 104, 100),
            rebalance(4, 2, 100, 103),
            rebalance(6, 3, 104, 100),
        ]
        .into_iter()
        .flatten()
        .collect();
        let rate = SolUsdRate::new(333_333_333).unwrap();
        for asset in [QuoteAsset::Sol, QuoteAsset::Usdc] {
            let values = value_movements(&events, asset, Some(DailyRate::Final(rate))).unwrap();
            let mut deposits = Valued::ZERO;
            let mut withdrawals = Valued::ZERO;
            for (event, value) in events.iter().zip(&values) {
                let amount = *value.as_ref().unwrap().value().unwrap();
                match event.kind {
                    PositionEventKind::RebalanceDeposit { .. } => {
                        deposits = deposits.try_add(amount).unwrap();
                    }
                    PositionEventKind::RebalanceWithdrawal(_) => {
                        withdrawals = withdrawals.try_add(amount).unwrap();
                    }
                    _ => panic!("unexpected fixture kind"),
                }
                assert_eq!(event.kind.flow().unwrap().base, RawTokenAmount(50));
                assert_eq!(event.kind.flow().unwrap().quote, RawTokenAmount(70));
            }
            assert_eq!(
                deposits,
                *value_quote(QuoteUnits(8), asset, Some(rate))
                    .unwrap()
                    .value()
                    .unwrap()
            );
            assert_eq!(
                withdrawals,
                *value_quote(QuoteUnits(3), asset, Some(rate))
                    .unwrap()
                    .value()
                    .unwrap()
            );
            for index in [0, 1, 2, 5, 6] {
                assert_eq!(values[index].as_ref().unwrap().value(), Some(&Valued::ZERO));
            }
        }
    }

    #[test]
    fn does_not_value_a_third_reward_mint_with_the_pool_bin() {
        use crate::facts::RewardFlow;
        let mut reward = claim(0);
        reward.kind = PositionEventKind::RewardClaim(RewardFlow {
            mint: Address::from_bytes([9; 32]),
            amount: RawTokenAmount(123),
            reward_index: 1,
            value: None,
        });
        let values = value_movements(
            &[reward.clone()],
            QuoteAsset::Sol,
            SolUsdRate::new(200_000_000).map(DailyRate::Final),
        )
        .unwrap();
        let unknown = values[0].as_ref().unwrap();
        assert!(unknown.value().is_none());
        assert_eq!(
            unknown.reasons(),
            Reasons::from([Reason::UnpricedLeg {
                position: reward.position
            }])
        );
    }
}
