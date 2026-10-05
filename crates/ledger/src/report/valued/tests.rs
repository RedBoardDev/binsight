use super::*;

fn rate() -> SolUsdRate {
    SolUsdRate::new(200_000_000).unwrap()
}

#[test]
fn values_a_sol_amount_in_both_currencies() {
    let valued = value_quote(QuoteUnits(1_500_000_000), QuoteAsset::Sol, Some(rate())).unwrap();
    let sol = resolve(&valued, Currency::Sol);
    let usd = resolve(&valued, Currency::Usd);
    assert_eq!(sol.value().unwrap().to_decimal_string(), "1.5");
    assert_eq!(usd.value().unwrap().to_decimal_string(), "300");
}

#[test]
fn values_a_stablecoin_amount_at_its_face_value() {
    let valued = value_quote(QuoteUnits(-50_000_000), QuoteAsset::Usdc, Some(rate())).unwrap();
    assert_eq!(
        resolve(&valued, Currency::Usd)
            .value()
            .unwrap()
            .to_decimal_string(),
        "-50"
    );
    assert_eq!(
        resolve(&valued, Currency::Sol)
            .value()
            .unwrap()
            .to_decimal_string(),
        "-0.25"
    );
}

#[test]
fn makes_dollars_without_a_rate_unavailable() {
    let sol_only = value_quote(QuoteUnits(1), QuoteAsset::Sol, None).unwrap();
    assert_eq!(
        resolve(&sol_only, Currency::Usd),
        Figure::unavailable(Reason::NoUsdRate)
    );
    assert_eq!(
        resolve(&sol_only, Currency::Sol).exactness(),
        Exactness::Complete
    );
    let stable = value_quote(QuoteUnits(1), QuoteAsset::Usdt, None).unwrap();
    assert_eq!(
        resolve(&stable, Currency::Sol),
        Figure::unavailable(Reason::NoUsdRate)
    );
    assert_eq!(resolve(&stable, Currency::Usd).value().unwrap().raw, 1);
    assert_eq!(
        resolve(&stable, Currency::Usd).exactness(),
        Exactness::Complete
    );
}

#[test]
fn divides_in_the_requested_currency() {
    let gain = Figure::Complete(Valued::of_sol(SignedLamports(1), Some(rate())).unwrap());
    let base = Figure::Complete(Valued::of_sol(SignedLamports(4), Some(rate())).unwrap());
    let percent = percent_of(&gain, &base, Currency::Sol).unwrap();
    assert_eq!(percent, Figure::Complete(Percent(25_000_000)));
}

#[test]
fn estimates_only_the_side_that_uses_the_provisional_rate() {
    let day = jiff::civil::date(2026, 10, 5);
    let rate = Some(DailyRate::Provisional { day, rate: rate() });
    for (asset, native, converted, amount) in [
        (QuoteAsset::Sol, Currency::Sol, Currency::Usd, 1_000_000_000),
        (QuoteAsset::Usdc, Currency::Usd, Currency::Sol, 200_000_000),
    ] {
        let figure = value_quote_at(QuoteUnits(amount), asset, rate).unwrap();
        let native = resolve(&figure, native);
        let converted = resolve(&figure, converted);
        assert_eq!(native.exactness(), Exactness::Complete);
        assert_eq!(native.reasons(), Reasons::new());
        assert_eq!(converted.exactness(), Exactness::Estimated);
        assert_eq!(
            converted.reasons(),
            Reasons::from([Reason::ProvisionalRate { day }])
        );
    }
}

#[test]
fn final_rates_leave_both_currencies_complete() {
    for asset in [QuoteAsset::Sol, QuoteAsset::Usdc] {
        let figure = value_quote_at(QuoteUnits(10), asset, Some(DailyRate::Final(rate()))).unwrap();
        for currency in [Currency::Sol, Currency::Usd] {
            assert_eq!(resolve(&figure, currency).exactness(), Exactness::Complete);
            assert_eq!(resolve(&figure, currency).reasons(), Reasons::new());
        }
    }
}

#[test]
fn sums_missing_conversions_independently_from_native_dollars() {
    let sol = value_quote(QuoteUnits(1_000_000_000), QuoteAsset::Sol, Some(rate())).unwrap();
    let dollar = value_quote(QuoteUnits(50_000_000), QuoteAsset::Usdc, None).unwrap();
    let total = sum_valued([sol, dollar]).unwrap();
    assert_eq!(
        resolve(&total, Currency::Usd).value().unwrap().raw,
        250_000_000
    );
    assert_eq!(
        resolve(&total, Currency::Usd).exactness(),
        Exactness::Complete
    );
    assert_eq!(
        resolve(&total, Currency::Sol),
        Figure::unavailable(Reason::NoUsdRate)
    );
}

#[test]
fn keeps_provisional_quality_per_currency_in_a_mixed_sum() {
    let day = jiff::civil::date(2026, 10, 5);
    let dollar = value_quote_at(
        QuoteUnits(50_000_000),
        QuoteAsset::Usdc,
        Some(DailyRate::Provisional { day, rate: rate() }),
    )
    .unwrap();
    let sol = value_quote(QuoteUnits(1_000_000_000), QuoteAsset::Sol, Some(rate())).unwrap();
    let forward = sum_valued([sol.clone(), dollar.clone()]).unwrap();
    let backward = sum_valued([dollar, sol]).unwrap();
    assert_eq!(forward, backward);
    assert_eq!(
        resolve(&forward, Currency::Sol).exactness(),
        Exactness::Estimated
    );
    assert_eq!(
        resolve(&forward, Currency::Usd).exactness(),
        Exactness::Complete
    );
}

#[test]
fn knows_zero_in_both_currencies_without_a_rate_or_with_a_provisional_one() {
    let day = jiff::civil::date(2026, 10, 5);
    for rate in [None, Some(DailyRate::Provisional { day, rate: rate() })] {
        for asset in [QuoteAsset::Sol, QuoteAsset::Usdc, QuoteAsset::Usdt] {
            let figure = value_quote_at(QuoteUnits(0), asset, rate).unwrap();
            for currency in [Currency::Sol, Currency::Usd] {
                let zero = resolve(&figure, currency);
                assert_eq!(zero.exactness(), Exactness::Complete);
                assert_eq!(zero.value().unwrap().raw, 0);
                assert_eq!(zero.reasons(), Reasons::new());
            }
        }
    }
}
