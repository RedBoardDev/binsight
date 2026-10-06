//! Native detail PnL preserves the position's selected token, method and source quality.
use binsight_core::error::AmountError;
use binsight_core::exactness::Exactness;
use binsight_core::money::SolUsdRate;
use binsight_dlmm::math::Q64x64;
use binsight_ledger::facts::{
    HistoryCoverage, PnlMethod, QuoteUnits, SolUsdRates, TokenKind, WalletFacts,
};
use binsight_ledger::report::closed::ClosedValuation;
use binsight_ledger::report::figure::{Figure, Reason, Reasons};
use binsight_ledger::report::open::OpenValuation;
use binsight_ledger::report::valued::quote::native_money;
use binsight_ledger::report::valued::{Currency, Money, MoneyUnit, resolve};
use jiff::Timestamp;

#[path = "native_position_pnl/fixtures.rs"]
mod fixtures;
use fixtures::{closed, money, pool, position, position_with_value, quote_oracles, rates};

#[test]
fn keeps_selected_asset_units_and_signed_raw_values_without_fx() {
    for (kind, unit, decimal) in [
        (TokenKind::Sol, MoneyUnit::Sol, "-0.000000007"),
        (TokenKind::Usdc, MoneyUnit::Usdc, "-0.000007"),
        (TokenKind::Usdt, MoneyUnit::Usdt, "-0.000007"),
    ] {
        for physical in [pool(kind, TokenKind::Other), pool(TokenKind::Other, kind)] {
            for raw in [i128::MIN, -7, 0, 1, i128::MAX] {
                assert_eq!(
                    native_money(Figure::Complete(QuoteUnits(raw)), &physical),
                    money(raw, unit)
                );
            }
            assert_eq!(
                native_money(Figure::Complete(QuoteUnits(-7)), &physical)
                    .value()
                    .unwrap()
                    .to_decimal_string(),
                decimal
            );
        }
    }
}

#[test]
fn distinguishes_injected_q64_prices_from_actual_bin_zero_before_one_fx_conversion() {
    for oracle in quote_oracles() {
        let pool = pool(oracle.physical.0, oracle.physical.1);
        let quoted = pool
            .quote_convention()
            .unwrap()
            .value_raw(oracle.x, oracle.y, Some(Q64x64(oracle.raw_price)))
            .unwrap();
        assert_eq!(
            quoted.amount,
            binsight_core::units::RawTokenAmount(u128::try_from(oracle.native).unwrap())
        );
        let position = position_with_value(&pool, oracle.native);
        let rates = SolUsdRates {
            spot: SolUsdRate::new(oracle.usd_micros_per_sol),
            ..SolUsdRates::default()
        };
        let valued = OpenValuation::of(&position, &pool, &rates).unwrap();
        assert_eq!(valued.native_pnl, money(oracle.native, MoneyUnit::Usdc));
        assert_eq!(
            resolve(&valued.pnl, Currency::Sol).value().unwrap().raw,
            oracle.sol_lamports
        );
    }
}

#[test]
fn keeps_native_open_and_closed_known_when_only_fx_is_missing() {
    for (kind, unit, converted) in [
        (TokenKind::Sol, MoneyUnit::Sol, Currency::Usd),
        (TokenKind::Usdc, MoneyUnit::Usdc, Currency::Sol),
        (TokenKind::Usdt, MoneyUnit::Usdt, Currency::Sol),
    ] {
        let pool = pool(kind, TokenKind::Other);
        let position = position(&pool);
        let open = OpenValuation::of(&position, &pool, &SolUsdRates::default()).unwrap();
        let close =
            ClosedValuation::of(&closed(&position), &pool, &SolUsdRates::default()).unwrap();
        assert_eq!(open.native_pnl, money(400, unit));
        assert_eq!(close.native_pnl, money(380, unit));
        for pnl in [&open.pnl, &close.pnl] {
            assert_eq!(
                resolve(pnl, converted),
                Figure::unavailable(Reason::NoUsdRate)
            );
        }
        assert_eq!(
            open.native_pnl,
            OpenValuation::of(&position, &pool, &rates())
                .unwrap()
                .native_pnl
        );
        assert_eq!(
            close.native_pnl,
            ClosedValuation::of(&closed(&position), &pool, &rates())
                .unwrap()
                .native_pnl
        );
    }
}

#[test]
fn retains_independent_value_and_fee_source_quality_without_inventing_zero() {
    let pool = pool(TokenKind::Usdc, TokenKind::Sol);
    for missing_value in [true, false] {
        for exactness in [
            Exactness::Partial,
            Exactness::Estimated,
            Exactness::Unavailable,
        ] {
            let mut position = position(&pool);
            let reasons = Reasons::from([Reason::UnpricedLeg {
                position: position.id,
            }]);
            if missing_value {
                position.value = Figure::from_parts(QuoteUnits(500), exactness, reasons.clone());
            } else {
                position.unclaimed_fees =
                    Figure::from_parts(QuoteUnits(20), exactness, reasons.clone());
            }
            let valued = OpenValuation::of(&position, &pool, &rates()).unwrap();
            assert_eq!(
                valued.native_pnl,
                Figure::from_parts(
                    Money {
                        raw: 400,
                        unit: MoneyUnit::Usdc
                    },
                    exactness,
                    reasons
                )
            );
            assert_eq!(valued.value.exactness(), position.value.exactness());
            assert_eq!(
                valued.unclaimed_fees.exactness(),
                position.unclaimed_fees.exactness()
            );
            assert_eq!(resolve(&valued.pnl, Currency::Usd).exactness(), exactness);
        }
    }
}

#[test]
fn shares_history_degradation_while_retaining_current_balances() {
    let pool = pool(TokenKind::Usdc, TokenKind::Sol);
    let position = position(&pool);
    let wallet = WalletFacts {
        address: position.wallet,
        added_at: Timestamp::UNIX_EPOCH,
        history: HistoryCoverage::Importing {
            indexed_since: None,
            progress: None,
        },
    };
    let valued = OpenValuation::of(&position, &pool, &SolUsdRates::default())
        .unwrap()
        .with_history(&wallet);
    assert_eq!(valued.native_pnl.exactness(), Exactness::Estimated);
    assert_eq!(
        valued.native_pnl.value(),
        money(400, MoneyUnit::Usdc).value()
    );
    assert_eq!(valued.native_pnl.reasons(), valued.pnl.reasons());
    assert_eq!(valued.value.exactness(), Exactness::Complete);
    assert_eq!(valued.unclaimed_fees.exactness(), Exactness::Complete);
    let close = ClosedValuation::of(&closed(&position), &pool, &SolUsdRates::default()).unwrap();
    assert_eq!(close.native_pnl, money(380, MoneyUnit::Usdc));
}

#[test]
fn qualifies_open_history_and_closed_methods_from_the_same_native_sources() {
    let pool = pool(TokenKind::Usdt, TokenKind::Sol);
    for (movements, rebalances, rewards, exactness) in [
        (1, 0, 0, Exactness::Estimated),
        (0, 1, 0, Exactness::Estimated),
        (0, 0, 1, Exactness::Partial),
    ] {
        let mut position = position(&pool);
        position.unpriced_movements = movements;
        position.unpriced_rebalances = rebalances;
        position.unpriced_rewards = rewards;
        let open = OpenValuation::of(&position, &pool, &rates()).unwrap();
        assert_eq!(open.native_pnl.exactness(), Exactness::Estimated);
        for method in [
            PnlMethod::Pool,
            PnlMethod::Fifo {
                market_pnl: QuoteUnits(-7),
            },
        ] {
            let mut position = closed(&position);
            position.method = method;
            let valued = ClosedValuation::of(&position, &pool, &rates()).unwrap();
            let raw = if method == PnlMethod::Pool { 380 } else { -7 };
            assert_eq!(
                valued.native_pnl.value(),
                Some(&Money {
                    raw,
                    unit: MoneyUnit::Usdt
                })
            );
            assert_eq!(valued.native_pnl.exactness(), exactness);
            assert_eq!(
                valued.native_pnl.reasons(),
                resolve(&valued.pnl, Currency::Usd).reasons()
            );
            assert_eq!(resolve(&valued.pnl, Currency::Usd).exactness(), exactness);
        }
    }
    let mut position = closed(&position(&pool));
    position.method = PnlMethod::Fifo {
        market_pnl: QuoteUnits(-7),
    };
    let valued = ClosedValuation::of(&position, &pool, &rates()).unwrap();
    assert_eq!(valued.native_pnl, money(-7, MoneyUnit::Usdt));
    assert_eq!(
        resolve(&valued.lp_pnl, Currency::Usd).value().unwrap().raw,
        380
    );
}

#[test]
fn limits_provisional_rate_quality_to_the_converted_closed_currency() {
    let day = jiff::civil::date(1970, 1, 1);
    for (kind, unit, converted) in [
        (TokenKind::Sol, MoneyUnit::Sol, Currency::Usd),
        (TokenKind::Usdc, MoneyUnit::Usdc, Currency::Sol),
    ] {
        let pool = pool(kind, TokenKind::Other);
        let rates = SolUsdRates {
            provisional: Some((day, SolUsdRate::new(2_000_000_000).unwrap())),
            ..SolUsdRates::default()
        };
        let valued = ClosedValuation::of(&closed(&position(&pool)), &pool, &rates).unwrap();
        assert_eq!(valued.native_pnl, money(380, unit));
        assert_eq!(
            resolve(&valued.pnl, converted).exactness(),
            Exactness::Estimated
        );
        assert_eq!(
            resolve(&valued.pnl, converted).reasons(),
            Reasons::from([Reason::ProvisionalRate { day }])
        );
    }
}

#[test]
fn keeps_unsupported_zero_and_source_failures_unavailable_with_their_reasons() {
    let pool = pool(TokenKind::Other, TokenKind::Other);
    let source = Reasons::from([Reason::UnpricedLeg {
        position: position(&pool).id,
    }]);
    let mut expected = source.clone();
    expected.insert(Reason::UnsupportedQuote { pool: pool.address });
    assert_eq!(
        native_money(Figure::Unavailable { reasons: source }, &pool),
        Figure::Unavailable { reasons: expected }
    );
    assert_eq!(
        native_money(Figure::Complete(QuoteUnits(0)), &pool),
        Figure::unavailable(Reason::UnsupportedQuote { pool: pool.address })
    );
    let position = position(&pool);
    assert_eq!(
        OpenValuation::of(&position, &pool, &rates())
            .unwrap()
            .native_pnl,
        Figure::unavailable(Reason::UnsupportedQuote { pool: pool.address })
    );
    assert_eq!(
        ClosedValuation::of(&closed(&position), &pool, &rates())
            .unwrap()
            .native_pnl,
        Figure::unavailable(Reason::UnsupportedQuote { pool: pool.address })
    );
}

#[test]
fn rejects_native_sum_overflow_for_both_position_states() {
    let pool = pool(TokenKind::Usdc, TokenKind::Sol);
    let mut position = position(&pool);
    position.claimed_fees = QuoteUnits(i128::MAX);
    assert_eq!(
        OpenValuation::of(&position, &pool, &SolUsdRates::default()),
        Err(AmountError::Overflow)
    );
    assert_eq!(
        ClosedValuation::of(&closed(&position), &pool, &SolUsdRates::default()),
        Err(AmountError::Overflow)
    );
    assert_eq!(binsight_ledger::calc_version::POSITIONS, 1);
}
