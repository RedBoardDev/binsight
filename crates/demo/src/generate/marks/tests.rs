//! Simulated marks retain valuation quality and reject monetary overflow.

use binsight_core::exactness::Exactness;
use binsight_ledger::facts::PositionId;
use binsight_ledger::report::figure::{Reason, Reasons};
use binsight_solana::{Address, Signature};

use super::*;

fn unpriced_leg() -> Reason {
    Reason::UnpricedLeg {
        position: PositionId {
            address: Address::from_bytes([1; 32]),
            opened_by: Signature::from_bytes([1; 64]),
        },
    }
}

#[test]
fn preserves_an_estimated_position_subtotal_in_the_interpolated_mark() {
    let subtotal = Figure::Estimated {
        value: Valued::of_sol(SignedLamports(80), None).unwrap(),
        reasons: Reasons::from([unpriced_leg()]),
    };
    let mut totals = vec![Figure::Complete(SignedLamports::ZERO)];
    add_span(
        &mut totals,
        1,
        (
            Timestamp::UNIX_EPOCH,
            Timestamp::from_second(7_200).unwrap(),
        ),
        &final_pnl(&subtotal),
    )
    .unwrap();
    assert_eq!(
        totals,
        vec![Figure::Estimated {
            value: SignedLamports(40),
            reasons: Reasons::from([unpriced_leg()]),
        }]
    );
}

#[test]
fn keeps_an_unavailable_position_valuation_unavailable_in_the_mark() {
    let unavailable = Figure::unavailable(unpriced_leg());
    assert_eq!(final_pnl(&unavailable).exactness(), Exactness::Unavailable);
    assert_eq!(final_pnl(&unavailable).reasons(), unavailable.reasons());
}

#[test]
fn resolves_provisional_sol_metadata_before_publishing_a_native_mark() {
    use binsight_core::money::SolUsdRate;
    use binsight_ledger::facts::{DailyRate, QuoteAsset, QuoteUnits};
    use binsight_ledger::report::valued::value_quote_at;
    let day = "2026-10-05".parse().unwrap();
    let converted = value_quote_at(
        QuoteUnits(100_000_000),
        QuoteAsset::Usdc,
        Some(DailyRate::Provisional {
            day,
            rate: SolUsdRate::new(200_000_000).unwrap(),
        }),
    )
    .unwrap();
    assert_eq!(converted.exactness(), Exactness::Complete);
    let mark = final_pnl(&converted);
    assert_eq!(mark.exactness(), Exactness::Estimated);
    assert_eq!(mark.value(), Some(&SignedLamports(500_000_000)));
    assert!(mark.reasons().contains(&Reason::ProvisionalRate { day }));
}

#[test]
fn rejects_interpolation_overflow_instead_of_saturating_the_mark() {
    let mut totals = vec![Figure::Complete(SignedLamports::ZERO)];
    let result = add_span(
        &mut totals,
        1,
        (
            Timestamp::UNIX_EPOCH,
            Timestamp::from_second(7_200).unwrap(),
        ),
        &Figure::Complete(SignedLamports(i128::MAX)),
    );
    assert_eq!(result, Err(DemoError::Amount(AmountError::Overflow)));
    assert_eq!(totals, vec![Figure::Complete(SignedLamports::ZERO)]);
}

#[test]
fn includes_the_previous_full_hour_for_a_subsecond_anchor_but_excludes_the_anchor_itself() {
    let flows = CashFlows {
        wallet: Address::from_bytes([1; 32]),
        label: "test",
        closed: Vec::new(),
        open: Vec::new(),
        entries: &[],
    };
    let first: Timestamp = "2026-10-05T12:30:00Z".parse().unwrap();
    let hour: Timestamp = "2026-10-05T14:00:00Z".parse().unwrap();
    let after: Timestamp = "2026-10-05T14:00:00.5Z".parse().unwrap();
    let exact = hourly_marks(&flows, first, hour).unwrap();
    let just_after = hourly_marks(&flows, first, after).unwrap();
    assert_eq!(exact.len(), 1);
    assert!(exact.iter().all(|mark| mark.at < hour));
    assert_eq!(just_after.len(), 2);
    assert_eq!(just_after.last().unwrap().at, hour);
}

#[test]
fn includes_an_hour_before_a_subsecond_close_but_not_before_a_subsecond_open() {
    let noon: Timestamp = "2026-10-05T12:00:00Z".parse().unwrap();
    let before: Timestamp = "2026-10-05T11:59:59.5Z".parse().unwrap();
    let after: Timestamp = "2026-10-05T12:00:00.5Z".parse().unwrap();
    let first_hour = noon.as_second().div_euclid(SECONDS_PER_HOUR);
    let mut totals = vec![Figure::Complete(SignedLamports::ZERO)];
    add_span(
        &mut totals,
        first_hour,
        (before, after),
        &Figure::Complete(SignedLamports(80)),
    )
    .unwrap();
    assert_eq!(totals, vec![Figure::Complete(SignedLamports(40))]);
    let mut closed_at_hour = vec![Figure::Complete(SignedLamports::ZERO)];
    add_span(
        &mut closed_at_hour,
        first_hour,
        (before, noon),
        &Figure::Complete(SignedLamports(80)),
    )
    .unwrap();
    assert_eq!(closed_at_hour, vec![Figure::Complete(SignedLamports::ZERO)]);
    let mut not_yet_open = vec![Figure::Complete(SignedLamports::ZERO)];
    add_span(
        &mut not_yet_open,
        first_hour,
        (
            after,
            after
                .checked_add(jiff::SignedDuration::from_secs(1))
                .unwrap(),
        ),
        &Figure::Complete(SignedLamports(80)),
    )
    .unwrap();
    assert_eq!(not_yet_open, vec![Figure::Complete(SignedLamports::ZERO)]);
}
