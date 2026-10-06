//! Range margins and the accuracy of open figures during a partial import.

use super::*;

const HALF: u128 = 500_000_000_000_000_000;
const ONE: u128 = 1_000_000_000_000_000_000;
const TWO: u128 = 2_000_000_000_000_000_000;

#[test]
fn does_not_call_pnl_a_lower_bound_when_an_old_deposit_is_missing() {
    use crate::facts::HistoryCoverage;
    use binsight_core::money::SignedLamports;
    use binsight_solana::Address;
    use jiff::Timestamp;

    let value = |amount| Figure::Complete(Valued::of_sol(SignedLamports(amount), None).unwrap());
    let known = OpenValuation {
        invested: value(20),
        withdrawn: value(0),
        net_invested: value(20),
        claimed_fees: value(0),
        rewards: value(0),
        value: value(100),
        unclaimed_fees: value(0),
        fees: value(0),
        pnl: value(80),
        native_pnl: Figure::Complete(Money {
            raw: 80,
            unit: super::super::valued::MoneyUnit::Sol,
        }),
        range: RangeStatus::InRange,
        composition: Composition::Mixed,
    };
    let wallet = WalletFacts {
        address: Address::from_bytes([1; 32]),
        added_at: Timestamp::UNIX_EPOCH,
        history: HistoryCoverage::Importing {
            indexed_since: None,
            progress: Some(Percent::ZERO),
        },
    };
    let incomplete = known.with_history(&wallet);
    // An older deposit of 180 changes the actual PnL to -100, below the known +80.
    assert_eq!(
        incomplete.pnl.value().unwrap().sol,
        Some(SignedLamports(80))
    );
    assert_eq!(incomplete.pnl.exactness(), Exactness::Estimated);
    assert_eq!(incomplete.net_invested.exactness(), Exactness::Estimated);
    assert_eq!(incomplete.invested.exactness(), Exactness::Partial);
    assert_eq!(incomplete.value.exactness(), Exactness::Complete);
    assert_eq!(incomplete.unclaimed_fees.exactness(), Exactness::Complete);
}

#[test]
fn measures_the_margins_against_the_current_price() {
    let (down, up) = range_margins(Price(ONE), Price(HALF), Price(TWO)).unwrap();
    assert_eq!(down.to_decimal_string(), "50");
    assert_eq!(up.to_decimal_string(), "100");
}

#[test]
fn gives_a_negative_margin_outside_the_range() {
    let (down, up) = range_margins(Price(TWO), Price(HALF), Price(ONE)).unwrap();
    assert_eq!(down.to_decimal_string(), "75");
    assert_eq!(up.to_decimal_string(), "-50");
}

#[path = "tests/closing_conversion.rs"]
mod closing_conversion;
#[path = "tests/display_range.rs"]
mod display_range;
#[path = "tests/fixtures.rs"]
mod fixtures;
#[path = "tests/native_definition.rs"]
mod native_definition;
#[path = "tests/source_quality.rs"]
mod source_quality;
