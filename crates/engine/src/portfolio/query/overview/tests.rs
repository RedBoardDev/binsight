//! Raw fee presence is independent of native monetary floors and missing source values.

use binsight_core::units::{Decimals, RawTokenAmount};
use binsight_dlmm::math::price_from_bin;
use binsight_ledger::facts::UnpricedMovements;
use binsight_ledger::facts::{
    OpenPositionFacts, PoolFacts, PositionId, QuoteUnits, TokenFacts, TokenKind,
};
use binsight_ledger::report::figure::{Figure, Reason};
use binsight_solana::Signature;
use jiff::Timestamp;

use super::*;
use crate::portfolio::SnapshotFacts;

fn pool(x: TokenKind, y: TokenKind) -> PoolFacts {
    let token = |side, kind| TokenFacts {
        mint: Address::from_bytes([side; 32]),
        symbol: None,
        name: None,
        decimals: Decimals(6),
        kind,
    };
    PoolFacts {
        address: Address::from_bytes([3; 32]),
        bin_step: 1_000,
        base: token(1, x),
        quote: token(2, y),
    }
}

fn position(index: u8, presence: Option<bool>, fees: Figure<QuoteUnits>) -> OpenPositionFacts {
    OpenPositionFacts {
        id: PositionId {
            address: Address::from_bytes([index; 32]),
            opened_by: Signature::from_bytes([index; 64]),
        },
        wallet: Address::from_bytes([index; 32]),
        pool: Address::from_bytes([3; 32]),
        strategy: None,
        opened_at: Timestamp::UNIX_EPOCH,
        invested: QuoteUnits(0),
        withdrawn: QuoteUnits(0),
        claimed_fees: QuoteUnits(0),
        rewards: QuoteUnits(0),
        unpriced_rewards: 0,
        value: Figure::Complete(QuoteUnits(0)),
        unclaimed_fees: fees,
        unclaimed_fee_presence: presence,
        lower_bin_id: -1,
        upper_bin_id: 1,
        active_bin_id: 0,
        bins: Vec::new(),
        range_since: None,
        valued_at: Timestamp::UNIX_EPOCH,
        unpriced_movements: UnpricedMovements::default(),
    }
}

#[test]
fn counts_observed_raw_fees_even_when_their_real_bin_quote_value_floors_to_zero() {
    for (x_kind, y_kind, bin, x, y) in [
        (TokenKind::Usdc, TokenKind::Other, 1, 0, 1),
        (TokenKind::Other, TokenKind::Usdc, -1, 1, 0),
    ] {
        let pool = pool(x_kind, y_kind);
        let native = pool
            .quote_convention()
            .unwrap()
            .value_raw(
                RawTokenAmount(x),
                RawTokenAmount(y),
                Some(price_from_bin(bin, pool.bin_step).unwrap()),
            )
            .unwrap();
        assert_eq!(native.amount, RawTokenAmount(0));
        let observed = Some(x > 0 || y > 0);
        let mut facts = position(4, observed, Figure::Complete(QuoteUnits(0)));
        facts.active_bin_id = bin;
        let snapshot = Snapshot::new(SnapshotFacts {
            pools: vec![pool],
            open: vec![facts],
            ..SnapshotFacts::default()
        })
        .unwrap();
        let summary = open_summary(&snapshot, Scope::All, Currency::Usd).unwrap();
        assert_eq!(summary.unclaimed_position_count, Some(1));
        assert_eq!(
            summary.unclaimed_fees.value().unwrap().to_decimal_string(),
            "0"
        );
    }
}

#[test]
fn keeps_unknown_fee_presence_unknown_and_classifies_the_other_scope_independently() {
    let mut unknown = position(5, None, Figure::Complete(QuoteUnits(0)));
    unknown.unclaimed_fees = Figure::Partial {
        value: QuoteUnits(0),
        reasons: [Reason::UnpricedLeg {
            position: unknown.id,
        }]
        .into(),
    };
    let snapshot = Snapshot::new(SnapshotFacts {
        pools: vec![pool(TokenKind::Other, TokenKind::Usdc)],
        open: vec![
            position(4, Some(true), Figure::Complete(QuoteUnits(1))),
            unknown,
        ],
        ..SnapshotFacts::default()
    })
    .unwrap();
    assert_eq!(
        open_summary(&snapshot, Scope::All, Currency::Usd)
            .unwrap()
            .unclaimed_position_count,
        None
    );
    assert_eq!(
        open_summary(
            &snapshot,
            Scope::Wallet(Address::from_bytes([4; 32])),
            Currency::Usd
        )
        .unwrap()
        .unclaimed_position_count,
        Some(1)
    );
    assert_eq!(
        open_summary(
            &snapshot,
            Scope::Wallet(Address::from_bytes([5; 32])),
            Currency::Usd
        )
        .unwrap()
        .unclaimed_position_count,
        None
    );
    assert_eq!(
        open_summary(
            &snapshot,
            Scope::Wallet(Address::from_bytes([6; 32])),
            Currency::Usd
        )
        .unwrap()
        .unclaimed_position_count,
        Some(0)
    );
}

#[test]
fn keeps_proved_raw_zero_classification_when_the_monetary_source_is_unavailable() {
    let mut zero = position(4, Some(false), Figure::Complete(QuoteUnits(0)));
    zero.unclaimed_fees = Figure::unavailable(Reason::UnpricedLeg { position: zero.id });
    let snapshot = Snapshot::new(SnapshotFacts {
        pools: vec![pool(TokenKind::Other, TokenKind::Usdc)],
        open: vec![zero],
        ..SnapshotFacts::default()
    })
    .unwrap();
    let summary = open_summary(&snapshot, Scope::All, Currency::Usd).unwrap();
    assert!(summary.unclaimed_fees.value().is_none());
    assert_eq!(summary.unclaimed_position_count, Some(0));
}
