//! Historical reconstruction cannot replace a missing SOL conversion with zero.
use super::*;
use crate::facts::{HistoryCoverage, QuoteAsset, QuoteUnits};
use crate::report::valued::{Currency, resolve, value_quote};
use binsight_solana::Address;

#[test]
fn leaves_sol_based_reconstruction_unavailable_without_a_required_conversion() {
    let at = Timestamp::from_second(100).unwrap();
    let dollar = value_quote(QuoteUnits(10), QuoteAsset::Usdc, None).unwrap();
    let rates = SolUsdRates::default();
    for missing_capital in [false, true] {
        let zero = Figure::Complete(Valued::ZERO);
        let (capital, realized) = if missing_capital {
            (dollar.clone(), zero)
        } else {
            (zero, dollar.clone())
        };
        let history = WalletHistory {
            wallet: WalletFacts {
                address: Address::from_bytes([1; 32]),
                added_at: Timestamp::UNIX_EPOCH,
                history: HistoryCoverage::Complete,
            },
            capital: RunningSum::new([(at, capital)]).unwrap(),
            realized: RunningSum::new([(at, realized)]).unwrap(),
            positions: RunningSum::new([(at, dollar.clone())]).unwrap(),
            marks: vec![OpenPnlMark {
                wallet: Address::from_bytes([1; 32]),
                at,
                open_pnl: Figure::Complete(SignedLamports::ZERO),
            }],
            exposure: OpenExposure::default(),
            first_activity: Some(at),
        };
        let point = history.point_at(at, &rates).unwrap();
        assert_eq!(point.net_worth.exactness(), Exactness::Unavailable);
        assert_eq!(point.real_pnl.exactness(), Exactness::Unavailable);
        assert!(point.real_pnl.reasons().contains(&Reason::NoUsdRate));
        let independent = resolve(&dollar, Currency::Usd);
        assert_eq!(independent.exactness(), Exactness::Complete);
        assert_eq!(independent.value().unwrap().raw, 10);
    }
}

#[test]
fn preserves_provisional_sol_quality_through_net_worth_reconstruction_in_both_currencies() {
    use crate::facts::DailyRate;
    use crate::report::valued::value_quote_at;
    use binsight_core::money::SolUsdRate;
    let prior: Timestamp = "2026-10-04T12:00:00Z".parse().unwrap();
    let at: Timestamp = "2026-10-05T12:00:00Z".parse().unwrap();
    let day = prior.to_zoned(jiff::tz::TimeZone::UTC).date();
    let rate = SolUsdRate::new(200_000_000).unwrap();
    let dollar = value_quote_at(
        QuoteUnits(100_000_000),
        QuoteAsset::Usdc,
        Some(DailyRate::Provisional { day, rate }),
    )
    .unwrap();
    let mut rates = SolUsdRates::default();
    rates
        .daily
        .insert(at.to_zoned(jiff::tz::TimeZone::UTC).date(), rate);
    for provisional_capital in [false, true] {
        let zero = Figure::Complete(Valued::ZERO);
        let (capital, realized) = if provisional_capital {
            (dollar.clone(), zero)
        } else {
            (zero, dollar.clone())
        };
        let history = WalletHistory {
            wallet: WalletFacts {
                address: Address::from_bytes([1; 32]),
                added_at: Timestamp::UNIX_EPOCH,
                history: HistoryCoverage::Complete,
            },
            capital: RunningSum::new([(prior, capital)]).unwrap(),
            realized: RunningSum::new([(prior, realized)]).unwrap(),
            positions: RunningSum::new([]).unwrap(),
            marks: vec![OpenPnlMark {
                wallet: Address::from_bytes([1; 32]),
                at,
                open_pnl: Figure::Complete(SignedLamports::ZERO),
            }],
            exposure: OpenExposure::default(),
            first_activity: Some(prior),
        };
        let point = history.point_at(at, &rates).unwrap();
        for currency in [Currency::Sol, Currency::Usd] {
            let worth = resolve(&point.net_worth, currency);
            assert_eq!(worth.exactness(), Exactness::Estimated);
            assert!(worth.reasons().contains(&Reason::ProvisionalRate { day }));
        }
        assert_eq!(
            resolve(&dollar, Currency::Usd).exactness(),
            Exactness::Complete
        );
    }
}
