//! Historical net capital is signed: missing deposits or withdrawals can reverse its sign.

use binsight_core::ratio::Percent;
use binsight_solana::Address;

use super::*;
use crate::facts::{HistoryCoverage, WalletEntryKind};
use crate::report::period::{Period, Window, WindowScope};
use crate::report::real_pnl::PnlTimeline;

const WALLET: Address = Address::from_bytes([7; 32]);

fn at(day: u8, hour: u8) -> Timestamp {
    format!("2026-10-{day:02}T{hour:02}:00:00Z")
        .parse()
        .unwrap()
}

fn importing(indexed_since: Option<Timestamp>) -> HistoryCoverage {
    HistoryCoverage::Importing {
        indexed_since,
        progress: Some(Percent(40_000_000)),
    }
}

fn history(entries: &[(Timestamp, SignedLamports)], coverage: HistoryCoverage) -> WalletHistory {
    let wallet = WalletFacts {
        address: WALLET,
        added_at: at(1, 0),
        history: coverage,
    };
    let entries: Vec<_> = entries
        .iter()
        .map(|(at, amount)| WalletEntry {
            wallet: WALLET,
            at: *at,
            kind: if amount.0 >= 0 {
                WalletEntryKind::CapitalDeposit
            } else {
                WalletEntryKind::CapitalWithdrawal
            },
            amount: *amount,
            signature: None,
        })
        .collect();
    let entries: Vec<_> = entries.iter().collect();
    WalletHistory::new(WalletHistoryFacts {
        wallet: &wallet,
        closed: &[],
        open: &[],
        entries: &entries,
        marks: &[],
        rates: &SolUsdRates::default(),
    })
    .unwrap()
}

fn assert_unknown(figure: &Figure<Valued>) {
    assert!(matches!(figure, Figure::Unavailable { .. }));
    assert!(figure.reasons().contains(&Reason::HistoryIncomplete {
        wallet: WALLET,
        progress: Some(Percent(40_000_000)),
    }));
}

fn assert_known(figure: &Figure<Valued>, expected: SignedLamports) {
    assert_eq!(figure.exactness(), Exactness::Complete);
    assert_eq!(figure.value().unwrap().sol, Some(expected));
}

#[test]
fn leaves_capital_unknown_when_missing_history_can_reverse_its_sign() {
    for (missing, observed, total) in [(100, -20, 80), (-100, 20, -80)] {
        let incomplete = history(
            &[(at(4, 12), SignedLamports(observed))],
            importing(Some(at(3, 0))),
        );
        let complete = history(
            &[
                (at(1, 0), SignedLamports(missing)),
                (at(4, 12), SignedLamports(observed)),
            ],
            HistoryCoverage::Complete,
        );
        assert_known(&complete.capital_at(at(4, 14)), SignedLamports(total));
        assert_unknown(&incomplete.capital_at(at(4, 14)));
        let point = incomplete
            .point_at(at(4, 14), &SolUsdRates::default())
            .unwrap();
        assert_unknown(&point.capital);
        assert_unknown(&point.real_pnl);
        assert_unknown(&point.net_worth);
        assert_known(
            &incomplete.capital_during(at(3, 0), at(4, 14)).unwrap(),
            SignedLamports(observed),
        );
        assert_unknown(&incomplete.capital_during(at(2, 0), at(4, 14)).unwrap());
    }
}

#[test]
fn does_not_infer_complete_origin_from_the_first_known_post_indexing_fact() {
    let history = history(
        &[(at(4, 12), SignedLamports(20))],
        importing(Some(at(3, 0))),
    );
    let wallets = [&history];
    let rates = SolUsdRates::default();
    let timeline = PnlTimeline::new(&wallets, &rates);
    let all = Window {
        scope: WindowScope::Period(Period::All),
        start: at(4, 0),
        end: at(4, 14),
    };
    assert_unknown(&timeline.net_deposits(&all).unwrap());
    let covered = Window {
        scope: WindowScope::Period(Period::Today),
        ..all
    };
    assert_known(
        &timeline.net_deposits(&covered).unwrap(),
        SignedLamports(20),
    );
}

#[test]
fn keeps_zero_unknown_before_the_first_import_page() {
    let history = history(&[], importing(None));
    assert_unknown(&history.capital_at(at(4, 14)));
    assert_unknown(&history.capital_during(at(4, 0), at(4, 14)).unwrap());
    assert_unknown(
        &history
            .point_at(at(4, 14), &SolUsdRates::default())
            .unwrap()
            .capital,
    );
}

#[test]
fn preserves_independently_observed_live_net_worth() {
    let history = history(
        &[(at(4, 12), SignedLamports(-20))],
        importing(Some(at(3, 0))),
    );
    let wallets = [&history];
    let rates = SolUsdRates::default();
    let worth = Figure::Complete(Valued::of_sol_at(SignedLamports(80), None).unwrap());
    let live = PnlTimeline::new(&wallets, &rates)
        .live(&worth, at(4, 14))
        .unwrap();
    assert_eq!(live.net_worth, worth);
    assert_unknown(&live.capital);
    assert_unknown(&live.real_pnl);
}

#[test]
fn excludes_the_window_end_but_includes_it_in_complete_cumulative_capital() {
    let entries = [
        (at(1, 0), SignedLamports(100)),
        (at(4, 14), SignedLamports(20)),
    ];
    let history = history(&entries, HistoryCoverage::Complete);
    assert_known(
        &history.capital_during(at(4, 0), at(4, 14)).unwrap(),
        SignedLamports::ZERO,
    );
    assert_known(&history.capital_at(at(4, 14)), SignedLamports(120));
}
