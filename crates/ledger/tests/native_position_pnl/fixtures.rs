//! Verified-decimal synthetic pools, prevalued positions and explicit physical-price oracles.
use binsight_core::money::SolUsdRate;
use binsight_core::units::{Decimals, RawTokenAmount};
use binsight_dlmm::math::{Q64x64, price_from_bin};
use binsight_ledger::facts::PositionHistory;
use binsight_ledger::facts::UnpricedMovements;
use binsight_ledger::facts::{
    ClosedPositionFacts, OpenPositionFacts, PnlMethod, PoolFacts, PositionId, QuoteUnits,
    SolUsdRates, TokenFacts, TokenKind,
};
use binsight_ledger::report::figure::Figure;
use binsight_ledger::report::valued::{Money, MoneyUnit};
use binsight_solana::{Address, Signature};
use jiff::Timestamp;

pub(super) fn pool(x: TokenKind, y: TokenKind) -> PoolFacts {
    let token = |kind, byte| TokenFacts {
        mint: Address::from_bytes([byte; 32]),
        symbol: None,
        name: None,
        decimals: if kind == TokenKind::Sol {
            Decimals::SOL
        } else {
            Decimals(6)
        },
        kind,
    };
    PoolFacts {
        address: Address::from_bytes([3; 32]),
        bin_step: 25,
        base: token(x, 1),
        quote: token(y, 2),
    }
}

pub(super) fn position(pool: &PoolFacts) -> OpenPositionFacts {
    OpenPositionFacts {
        id: PositionId {
            address: Address::from_bytes([4; 32]),
            opened_by: Signature::from_bytes([5; 64]),
        },
        wallet: Address::from_bytes([6; 32]),
        pool: pool.address,
        strategy: None,
        opened_at: Timestamp::UNIX_EPOCH,
        invested: QuoteUnits(150),
        withdrawn: QuoteUnits(0),
        claimed_fees: QuoteUnits(30),
        rewards: QuoteUnits(0),
        unpriced_rewards: 0,
        value: Figure::Complete(QuoteUnits(500)),
        unclaimed_fees: Figure::Complete(QuoteUnits(20)),
        unclaimed_fee_presence: Some(true),
        lower_bin_id: -2,
        upper_bin_id: 2,
        active_bin_id: 0,
        bins: Vec::new(),
        range_since: None,
        valued_at: Timestamp::UNIX_EPOCH,
        history: PositionHistory::Whole,
        unpriced_movements: UnpricedMovements::default(),
    }
}

pub(super) fn closed(position: &OpenPositionFacts) -> ClosedPositionFacts {
    ClosedPositionFacts {
        id: position.id,
        wallet: position.wallet,
        pool: position.pool,
        strategy: None,
        opened_at: position.opened_at,
        closed_at: position.valued_at,
        invested: position.invested,
        withdrawn: QuoteUnits(500),
        claimed_fees: position.claimed_fees,
        rewards: position.rewards,
        unpriced_rewards: position.unpriced_rewards,
        method: PnlMethod::Pool,
        history: position.history,
        unpriced_movements: position.unpriced_movements,
    }
}

pub(super) fn money(raw: i128, unit: MoneyUnit) -> Figure<Money> {
    Figure::Complete(Money { raw, unit })
}

#[expect(clippy::unwrap_used, reason = "the fixture exchange rate is positive")]
pub(super) fn rates() -> SolUsdRates {
    let rate = SolUsdRate::new(2_000_000_000).unwrap();
    SolUsdRates {
        spot: Some(rate),
        daily: [(jiff::civil::date(1970, 1, 1), rate)].into(),
        provisional: None,
    }
}

pub(super) fn position_with_value(pool: &PoolFacts, native: i128) -> OpenPositionFacts {
    let mut position = position(pool);
    position.invested = QuoteUnits(0);
    position.claimed_fees = QuoteUnits(0);
    position.value = Figure::Complete(QuoteUnits(native));
    position.unclaimed_fees = Figure::Complete(QuoteUnits(0));
    position.unclaimed_fee_presence = Some(false);
    position
}

pub(super) struct QuoteOracle {
    pub(super) physical: (TokenKind, TokenKind),
    pub(super) raw_price: u128,
    pub(super) x: RawTokenAmount,
    pub(super) y: RawTokenAmount,
    pub(super) native: i128,
    pub(super) usd_micros_per_sol: u64,
    pub(super) sol_lamports: i128,
}

#[expect(clippy::unwrap_used, reason = "bin zero has an exact unit price")]
pub(super) fn quote_oracles() -> [QuoteOracle; 4] {
    let bin_zero = price_from_bin(0, 25).unwrap();
    assert_eq!(bin_zero, Q64x64::ONE);
    [
        (
            TokenKind::Other,
            TokenKind::Usdc,
            Q64x64::ONE.0 / 2,
            520_000_000,
            1_000_000_000,
            520_000_000,
        ),
        (
            TokenKind::Usdc,
            TokenKind::Other,
            Q64x64::ONE.0 * 2,
            520_000_000,
            1_000_000_000,
            520_000_000,
        ),
        (
            TokenKind::Other,
            TokenKind::Usdc,
            bin_zero.0,
            1_020_000_000,
            2_000_000_000,
            510_000_000,
        ),
        (
            TokenKind::Usdc,
            TokenKind::Other,
            bin_zero.0,
            1_020_000_000,
            2_000_000_000,
            510_000_000,
        ),
    ]
    .map(
        |(x, y, raw_price, native, usd_micros_per_sol, sol_lamports)| QuoteOracle {
            physical: (x, y),
            x: RawTokenAmount(if x == TokenKind::Other {
                1_000_000_000
            } else {
                20_000_000
            }),
            y: RawTokenAmount(if y == TokenKind::Other {
                1_000_000_000
            } else {
                20_000_000
            }),
            raw_price,
            native,
            usd_micros_per_sol,
            sol_lamports,
        },
    )
}
