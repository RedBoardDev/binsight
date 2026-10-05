//! Historical marks carry their age and source quality, independent of cutoff cash flows.

use super::exposure::PositionLifetime;
use super::*;
use crate::facts::{HistoryCoverage, PositionId};
use crate::report::valued::{Currency, resolve};
use binsight_solana::{Address, Signature};

fn at(time: &str) -> Timestamp {
    format!("2026-10-05T{time}Z").parse().unwrap()
}

fn make_history(mark: Option<OpenPnlMark>, closed_at: Option<Timestamp>) -> WalletHistory {
    let wallet = Address::from_bytes([1; 32]);
    WalletHistory {
        wallet: WalletFacts {
            address: wallet,
            added_at: at("00:00:00"),
            history: HistoryCoverage::Complete,
        },
        capital: RunningSum::new([(
            at("11:30:00"),
            Figure::Complete(Valued::of_sol(SignedLamports(20), None).unwrap()),
        )])
        .unwrap(),
        realized: RunningSum::new([(
            at("11:45:00"),
            Figure::Complete(Valued::of_sol(SignedLamports(3), None).unwrap()),
        )])
        .unwrap(),
        positions: RunningSum::new([]).unwrap(),
        marks: mark.into_iter().collect(),
        exposure: OpenExposure::from_lifetimes(vec![PositionLifetime {
            opened_at: at("11:00:00"),
            closed_at,
        }]),
        first_activity: Some(at("11:00:00")),
    }
}

fn mark(quality: Figure<SignedLamports>) -> OpenPnlMark {
    OpenPnlMark {
        wallet: Address::from_bytes([1; 32]),
        at: at("11:00:00"),
        open_pnl: quality,
    }
}

#[test]
fn includes_cash_flows_at_the_requested_half_hour_and_quarter_hour_despite_an_old_mark() {
    let history = make_history(Some(mark(Figure::Complete(SignedLamports(5)))), None);
    for (instant, age, pnl) in [(at("11:30:00"), 1_800, 5), (at("11:45:00"), 2_700, 8)] {
        let point = history.point_at(instant, &SolUsdRates::default()).unwrap();
        assert_eq!(point.capital.value().unwrap().sol, Some(SignedLamports(20)));
        assert_eq!(point.capital.exactness(), Exactness::Complete);
        assert_eq!(
            point.real_pnl.value().unwrap().sol,
            Some(SignedLamports(pnl))
        );
        assert_eq!(
            point.net_worth.value().unwrap().sol,
            Some(SignedLamports(20_i128.checked_add(pnl).unwrap()))
        );
        assert_eq!(point.real_pnl.exactness(), Exactness::Estimated);
        assert!(
            point
                .real_pnl
                .reasons()
                .contains(&Reason::StaleMark { age_seconds: age })
        );
    }
}

#[test]
fn cannot_reconstruct_open_pnl_without_a_mark_but_keeps_capital_known() {
    let history = make_history(None, None);
    let point = history
        .point_at(at("11:45:00"), &SolUsdRates::default())
        .unwrap();
    let reason = Reason::MissingOpenPnlMark {
        wallet: history.address(),
    };
    assert_eq!(point.real_pnl, Figure::unavailable(reason));
    assert_eq!(point.net_worth, Figure::unavailable(reason));
    assert_eq!(point.capital.exactness(), Exactness::Complete);
    assert_eq!(point.capital.value().unwrap().sol, Some(SignedLamports(20)));
}

#[test]
fn proves_zero_open_pnl_outside_lifetimes_even_if_an_old_mark_was_nonzero() {
    let history = make_history(
        Some(mark(Figure::Complete(SignedLamports(5)))),
        Some(at("11:30:00")),
    );
    for instant in [at("10:59:59"), at("11:30:00")] {
        assert_eq!(
            history.open_pnl_at(instant),
            Figure::Complete(SignedLamports::ZERO)
        );
    }
    let without_mark = make_history(None, Some(at("11:30:00")));
    assert_eq!(
        without_mark.open_pnl_at(at("11:45:00")),
        Figure::Complete(SignedLamports::ZERO)
    );
}

#[test]
fn preserves_an_estimated_positive_subtotal_that_an_unpriced_cost_can_reverse() {
    let reason = Reason::UnpricedLeg {
        position: PositionId {
            address: Address::from_bytes([2; 32]),
            opened_by: Signature::from_bytes([2; 64]),
        },
    };
    let subtotal = Figure::Estimated {
        value: SignedLamports(80),
        reasons: Reasons::from([reason]),
    };
    let history = make_history(Some(mark(subtotal.clone())), None);
    assert_eq!(history.open_pnl_at(at("11:00:00")), subtotal);
    let point = history
        .point_at(at("11:00:00"), &SolUsdRates::default())
        .unwrap();
    let observed = resolve(&point.real_pnl, Currency::Sol);
    assert_eq!(observed.value().unwrap().raw, 80);
    assert_eq!(observed.exactness(), Exactness::Estimated);
    assert!(observed.reasons().contains(&reason));
    // Adding the missing 180-lamport cost yields -100, so +80 cannot be a lower bound.
    assert_eq!(80_i128.checked_sub(180).unwrap(), -100);
}

#[test]
fn requires_the_exact_mark_instant_for_complete_open_pnl() {
    let history = make_history(Some(mark(Figure::Complete(SignedLamports(5)))), None);
    assert_eq!(
        history.open_pnl_at(at("11:00:00")),
        Figure::Complete(SignedLamports(5))
    );
    assert_eq!(
        history.open_pnl_at(at("11:00:01")).exactness(),
        Exactness::Estimated
    );
    let subsecond = history.open_pnl_at(at("11:00:00.5"));
    assert_eq!(subsecond.exactness(), Exactness::Estimated);
    assert!(
        subsecond
            .reasons()
            .contains(&Reason::StaleMark { age_seconds: 0 })
    );
}
