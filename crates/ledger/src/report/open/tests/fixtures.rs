//! Synthetic physical pool facts and explicitly prevalued position fixtures: a USDC-quoted pool
//! whose other token is not SOL, so USDC is the quote on either physical side.

use super::super::*;
use crate::facts::PositionHistory;
use crate::facts::UnpricedMovements;

pub(super) fn pool(side: PhysicalSide) -> PoolFacts {
    use crate::facts::{TokenFacts, TokenKind};
    use binsight_core::units::Decimals;
    use binsight_solana::Address;

    let token = |kind, byte| TokenFacts {
        mint: Address::from_bytes([byte; 32]),
        symbol: None,
        name: None,
        decimals: Decimals(if kind == TokenKind::Other { 9 } else { 6 }),
        kind,
    };
    let (base, quote) = match side {
        PhysicalSide::X => (token(TokenKind::Usdc, 1), token(TokenKind::Other, 2)),
        PhysicalSide::Y => (token(TokenKind::Other, 2), token(TokenKind::Usdc, 1)),
    };
    PoolFacts {
        address: Address::from_bytes([3; 32]),
        bin_step: 25,
        base,
        quote,
    }
}

pub(super) fn position(pool: &PoolFacts) -> OpenPositionFacts {
    use crate::facts::PositionId;
    use binsight_solana::{Address, Signature};
    use jiff::Timestamp;

    let at: Timestamp = "2026-10-05T12:00:00Z".parse().unwrap();
    OpenPositionFacts {
        id: PositionId {
            address: Address::from_bytes([4; 32]),
            opened_by: Signature::from_bytes([5; 64]),
        },
        wallet: Address::from_bytes([6; 32]),
        pool: pool.address,
        strategy: None,
        opened_at: at,
        invested: QuoteUnits(0),
        withdrawn: QuoteUnits(0),
        claimed_fees: QuoteUnits(0),
        rewards: QuoteUnits(0),
        unpriced_rewards: 0,
        value: Figure::Complete(QuoteUnits(520_000_000)),
        unclaimed_fees: Figure::Complete(QuoteUnits(0)),
        unclaimed_fee_presence: Some(false),
        lower_bin_id: -2,
        upper_bin_id: 2,
        active_bin_id: 0,
        bins: Vec::new(),
        range_since: None,
        valued_at: at,
        history: PositionHistory::Whole,
        unpriced_movements: UnpricedMovements::default(),
    }
}

pub(super) fn closed(position: &OpenPositionFacts) -> crate::facts::ClosedPositionFacts {
    use crate::facts::{ClosedPositionFacts, PnlMethod};
    ClosedPositionFacts {
        id: position.id,
        wallet: position.wallet,
        pool: position.pool,
        strategy: position.strategy,
        opened_at: position.opened_at,
        closed_at: position.valued_at,
        invested: position.invested,
        withdrawn: QuoteUnits(520_000_000),
        claimed_fees: position.claimed_fees,
        rewards: position.rewards,
        unpriced_rewards: position.unpriced_rewards,
        method: PnlMethod::Pool,
        history: position.history,
        unpriced_movements: position.unpriced_movements,
    }
}

pub(super) fn raw(figure: &Figure<Valued>, currency: crate::report::valued::Currency) -> i128 {
    crate::report::valued::resolve(figure, currency)
        .value()
        .unwrap()
        .raw
}
