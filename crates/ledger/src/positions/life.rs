//! One open life of a position, and the facts it becomes when it closes or is valued live.

use binsight_solana::Address;
use jiff::Timestamp;

use super::PositionFlows;
use crate::book::RentPayer;
use crate::facts::{
    BinLiquidity, ClosedPositionFacts, OpenPositionFacts, PnlMethod, PositionHistory, PositionId,
    QuoteUnits,
};
use crate::report::figure::Figure;

/// A position of the wallet that is still open, and what it moved so far.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpenLife {
    /// The identity of this life of the position.
    pub id: PositionId,
    /// Its pool.
    pub pool: Address,
    /// When it was created, or first seen when its creation is not in the history.
    pub opened_at: Timestamp,
    /// What its movements add up to so far.
    pub flows: PositionFlows,
    /// Whether every transaction of its life so far was counted.
    pub history: PositionHistory,
    /// Who paid the rent of its account at its creation; `None` when the creation is not in
    /// the history.
    pub rent_payer: Option<RentPayer>,
}

/// What a snapshot of an open position's accounts says about it now, in its pool's quote token.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LiveValuation {
    /// The value of its liquidity at the active bin.
    pub value: Figure<QuoteUnits>,
    /// The value of the fees it could claim.
    pub unclaimed_fees: Figure<QuoteUnits>,
    /// Whether its raw unclaimed fees are nonzero; `None` when unknown.
    pub unclaimed_fee_presence: Option<bool>,
    /// The lowest bin of its range.
    pub lower_bin_id: i32,
    /// The highest bin of its range.
    pub upper_bin_id: i32,
    /// The pool's active bin.
    pub active_bin_id: i32,
    /// Its liquidity in each bin of its range, lowest bin first.
    pub bins: Vec<BinLiquidity>,
    /// Since when the active bin is on its current side of the range.
    pub range_since: Option<Timestamp>,
    /// When the snapshot was read.
    pub valued_at: Timestamp,
}

impl OpenLife {
    /// A life that starts at `opened_at` with no movement yet.
    pub(super) fn new(id: PositionId, pool: Address, opened_at: Timestamp) -> Self {
        Self {
            id,
            pool,
            opened_at,
            flows: PositionFlows::default(),
            history: PositionHistory::Whole,
            rent_payer: None,
        }
    }

    /// Records that part of this life was not counted; the first gap found is kept.
    pub(super) fn mark_gap(&mut self, gap: PositionHistory) {
        if self.history == PositionHistory::Whole {
            self.history = gap;
        }
    }

    /// The facts of this life once closed at `closed_at`, from `wallet`'s point of view.
    pub(super) fn close(self, wallet: Address, closed_at: Timestamp) -> ClosedPositionFacts {
        let flows = self.flows;
        ClosedPositionFacts {
            id: self.id,
            wallet,
            pool: self.pool,
            strategy: None,
            opened_at: self.opened_at,
            closed_at,
            invested: flows.invested,
            withdrawn: flows.withdrawn,
            claimed_fees: flows.claimed_fees,
            rewards: flows.rewards,
            unpriced_rewards: flows.unpriced_rewards,
            method: PnlMethod::Pool,
            history: self.history,
            dust_movements: flows.dust_movements,
            unpriced_movements: flows.unpriced_movements,
        }
    }

    /// The facts of this life, owned by `wallet`, valued at `live`.
    pub fn open_facts(&self, wallet: Address, live: LiveValuation) -> OpenPositionFacts {
        let flows = self.flows;
        OpenPositionFacts {
            id: self.id,
            wallet,
            pool: self.pool,
            strategy: None,
            opened_at: self.opened_at,
            invested: flows.invested,
            withdrawn: flows.withdrawn,
            claimed_fees: flows.claimed_fees,
            rewards: flows.rewards,
            unpriced_rewards: flows.unpriced_rewards,
            value: live.value,
            unclaimed_fees: live.unclaimed_fees,
            unclaimed_fee_presence: live.unclaimed_fee_presence,
            lower_bin_id: live.lower_bin_id,
            upper_bin_id: live.upper_bin_id,
            active_bin_id: live.active_bin_id,
            bins: live.bins,
            range_since: live.range_since,
            valued_at: live.valued_at,
            history: self.history,
            dust_movements: flows.dust_movements,
            unpriced_movements: flows.unpriced_movements,
        }
    }
}
