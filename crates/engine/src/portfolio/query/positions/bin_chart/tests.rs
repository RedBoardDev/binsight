//! Invalid bin depths fail explicitly instead of producing plausible zero or clamped bars.

use binsight_core::ratio::RatioError;
use binsight_core::units::Decimals;
use binsight_ledger::facts::{PositionId, QuoteUnits, TokenFacts, TokenKind};
use binsight_ledger::report::ReadRuleError;
use binsight_solana::{Address, Signature};
use jiff::Timestamp;

use super::*;

fn pool() -> PoolFacts {
    let token = TokenFacts {
        mint: Address::from_bytes([2; 32]),
        symbol: None,
        name: None,
        decimals: Decimals::SOL,
        kind: TokenKind::Sol,
    };
    PoolFacts {
        address: Address::from_bytes([1; 32]),
        bin_step: 10_000,
        base: TokenFacts {
            mint: Address::from_bytes([3; 32]),
            decimals: Decimals(6),
            kind: TokenKind::Other,
            ..token.clone()
        },
        quote: token,
    }
}

fn position(bins: Vec<BinLiquidity>) -> OpenPositionFacts {
    OpenPositionFacts {
        id: PositionId {
            address: Address::from_bytes([3; 32]),
            opened_by: Signature::from_bytes([4; 64]),
        },
        wallet: Address::from_bytes([5; 32]),
        pool: pool().address,
        strategy: None,
        opened_at: Timestamp::UNIX_EPOCH,
        invested: QuoteUnits(0),
        withdrawn: QuoteUnits(0),
        claimed_fees: QuoteUnits(0),
        rewards: QuoteUnits(0),
        unpriced_rewards: 0,
        value: QuoteUnits(0),
        unclaimed_fees: QuoteUnits(0),
        lower_bin_id: 0,
        upper_bin_id: 1,
        active_bin_id: 0,
        bins,
        range_since: None,
        valued_at: Timestamp::UNIX_EPOCH,
        unpriced_movements: 0,
        unpriced_rebalances: 0,
    }
}

fn bin(bin_id: i32, base: u128, quote: u128) -> BinLiquidity {
    BinLiquidity {
        bin_id,
        base: RawTokenAmount(base),
        quote: RawTokenAmount(quote),
    }
}

fn assert_amount_overflow<T>(result: &Result<T, ReadError>) {
    assert!(matches!(
        result,
        Err(ReadError::Rule(ReadRuleError::Amount(
            AmountError::Overflow
        )))
    ));
}

#[test]
fn values_each_grouped_bin_at_its_own_price() {
    let group = merge(&[bin(0, 100, 3), bin(1, 100, 7)], &pool()).unwrap();
    assert_eq!(group.liquidity.base, RawTokenAmount(200));
    assert_eq!(group.liquidity.quote, RawTokenAmount(10));
    assert_eq!(group.value, RawTokenAmount(310));
    assert_eq!(
        value_at_own_price(&group.liquidity, &pool()).unwrap(),
        RawTokenAmount(210)
    );
}

#[test]
fn refuses_raw_amount_and_depth_overflows() {
    assert_amount_overflow(&merge(&[bin(0, u128::MAX, 0), bin(0, 1, 0)], &pool()));
    assert_amount_overflow(&merge(&[bin(0, 0, u128::MAX), bin(0, 0, 1)], &pool()));
    assert_amount_overflow(&value_at_own_price(&bin(0, u128::MAX, 1), &pool()));
    assert_amount_overflow(&value_at_own_price(&bin(1, u128::MAX, 0), &pool()));
}

#[test]
fn refuses_a_bin_price_failure_instead_of_treating_base_liquidity_as_zero() {
    let result = bin_chart(&position(vec![bin(600_000, 1, 7)]), &pool());
    assert_eq!(
        result,
        Err(ReadError::BinOutOfRange {
            pool: pool().address,
            bin_id: 600_000
        })
    );
}

#[test]
fn refuses_amount_clamping_and_ratio_overflow() {
    assert_amount_overflow(&height(
        RawTokenAmount(u128::MAX),
        RawTokenAmount(u128::MAX),
    ));
    assert_eq!(
        height(
            RawTokenAmount(i128::MAX.unsigned_abs()),
            RawTokenAmount(i128::MAX.unsigned_abs())
        ),
        Err(ReadError::Rule(ReadRuleError::Ratio(RatioError::Overflow)))
    );
}

#[test]
fn only_draws_zero_height_for_proved_zero_depth() {
    let chart = bin_chart(&position(vec![bin(0, 0, 0)]), &pool()).unwrap();
    assert_eq!(chart.bars[0].height, Ratio(0));
    assert_eq!(
        height(RawTokenAmount(1), RawTokenAmount(0)),
        Err(ReadError::Rule(ReadRuleError::Ratio(
            RatioError::ZeroDenominator
        )))
    );
    assert_eq!(
        bin_chart(&position(Vec::new()), &pool()).unwrap().bars,
        Vec::new()
    );
}

#[test]
fn groups_the_chart_without_losing_raw_amounts_or_changing_its_range() {
    let bins = (0..=MAX_BIN_BARS)
        .map(|index| bin(i32::try_from(index).unwrap(), 1, 2))
        .collect();
    let mut position = position(bins);
    position.upper_bin_id = i32::try_from(MAX_BIN_BARS).unwrap();
    let mut pool = pool();
    pool.bin_step = 10;
    let chart = bin_chart(&position, &pool).unwrap();
    assert!(chart.bars.len() <= MAX_BIN_BARS);
    assert_eq!(
        chart.bars.iter().map(|bar| bar.base.0).sum::<u128>(),
        u128::try_from(MAX_BIN_BARS + 1).unwrap()
    );
    assert_eq!(
        chart.bars.iter().map(|bar| bar.quote.0).sum::<u128>(),
        2 * u128::try_from(MAX_BIN_BARS + 1).unwrap()
    );
    assert_eq!(
        (chart.lower_bin_id, chart.upper_bin_id, chart.active_bin_id),
        (0, i32::try_from(MAX_BIN_BARS).unwrap(), 0)
    );
    assert_eq!(chart.bars[0].height, Ratio(1_000_000));
    assert_eq!(chart.bars.last().unwrap().height, Ratio(500_000));
}
