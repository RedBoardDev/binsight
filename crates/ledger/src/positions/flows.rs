//! What a position's movements add up to, in its pool's quote token.

use binsight_dlmm::activity::MovementKind;

use super::FoldError;
use crate::facts::{FlowValuation, QuoteUnits};
use crate::report::valued::quote::QuotedAmount;

/// The sums of a position's movements so far, valued in its pool's quote token.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct PositionFlows {
    /// Every deposit, the re-deposits of rebalances included.
    pub invested: QuoteUnits,
    /// Every withdrawal, the withdrawals of rebalances included.
    pub withdrawn: QuoteUnits,
    /// Every fee claim, the fees a rebalance harvested included.
    pub claimed_fees: QuoteUnits,
    /// Every reward that could be valued.
    pub rewards: QuoteUnits,
    /// Movements counted on their quote side only, or not at all for a pool without a
    /// supported quote token.
    pub unpriced_movements: u32,
    /// Nonzero rewards left out of [`Self::rewards`] for want of a price.
    pub unpriced_rewards: u32,
}

impl PositionFlows {
    /// Adds a movement of `kind`, valued at `quoted`; `None` when its pool has no quote token.
    pub(super) fn add_movement(
        &mut self,
        kind: MovementKind,
        quoted: Option<QuotedAmount>,
    ) -> Result<(), FoldError> {
        let Some(quoted) = quoted else {
            return count(&mut self.unpriced_movements);
        };
        if quoted.valuation == FlowValuation::QuoteOnly {
            count(&mut self.unpriced_movements)?;
        }
        let total = match kind {
            MovementKind::Deposit | MovementKind::RebalanceDeposit => &mut self.invested,
            MovementKind::Withdrawal | MovementKind::RebalanceWithdrawal => &mut self.withdrawn,
            MovementKind::FeeClaim => &mut self.claimed_fees,
        };
        let amount = i128::try_from(quoted.amount.0).map_err(|_| FoldError::Overflow)?;
        add(total, amount)
    }

    /// Adds a nonzero reward, valued at `value` when its price is known.
    pub(super) fn add_reward(&mut self, value: Option<QuoteUnits>) -> Result<(), FoldError> {
        match value {
            Some(value) => add(&mut self.rewards, value.0),
            None => count(&mut self.unpriced_rewards),
        }
    }
}

fn add(total: &mut QuoteUnits, amount: i128) -> Result<(), FoldError> {
    total.0 = total.0.checked_add(amount).ok_or(FoldError::Overflow)?;
    Ok(())
}

fn count(counter: &mut u32) -> Result<(), FoldError> {
    *counter = counter.checked_add(1).ok_or(FoldError::Overflow)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use binsight_core::units::RawTokenAmount;

    use super::*;

    fn quoted(amount: u128, valuation: FlowValuation) -> QuotedAmount {
        QuotedAmount {
            amount: RawTokenAmount(amount),
            valuation,
        }
    }

    #[test]
    fn sums_each_kind_of_movement_into_its_own_figure() {
        let mut flows = PositionFlows::default();
        for (kind, amount) in [
            (MovementKind::Deposit, 100),
            (MovementKind::RebalanceWithdrawal, 40),
            (MovementKind::RebalanceDeposit, 41),
            (MovementKind::Withdrawal, 99),
            (MovementKind::FeeClaim, 3),
        ] {
            flows
                .add_movement(kind, Some(quoted(amount, FlowValuation::Complete)))
                .unwrap();
        }
        flows.add_reward(Some(QuoteUnits(2))).unwrap();
        assert_eq!(
            flows,
            PositionFlows {
                invested: QuoteUnits(141),
                withdrawn: QuoteUnits(139),
                claimed_fees: QuoteUnits(3),
                rewards: QuoteUnits(2),
                unpriced_movements: 0,
                unpriced_rewards: 0,
            }
        );
    }

    #[test]
    fn keeps_the_known_quote_side_and_counts_what_has_no_price() {
        let mut flows = PositionFlows::default();
        flows
            .add_movement(
                MovementKind::FeeClaim,
                Some(quoted(112_397_677, FlowValuation::QuoteOnly)),
            )
            .unwrap();
        flows.add_movement(MovementKind::Deposit, None).unwrap();
        flows.add_reward(None).unwrap();
        assert_eq!(flows.claimed_fees, QuoteUnits(112_397_677));
        assert_eq!(flows.invested, QuoteUnits(0));
        assert_eq!(flows.unpriced_movements, 2);
        assert_eq!(flows.unpriced_rewards, 1);
    }

    #[test]
    fn refuses_a_total_beyond_its_integer_range() {
        let mut flows = PositionFlows {
            invested: QuoteUnits(i128::MAX),
            ..PositionFlows::default()
        };
        assert_eq!(
            flows.add_movement(
                MovementKind::Deposit,
                Some(quoted(1, FlowValuation::Complete))
            ),
            Err(FoldError::Overflow)
        );
    }
}
