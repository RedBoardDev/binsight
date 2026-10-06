//! Detail-only native leaves preserve list figures, exact lifetime identity and conversion quality.

#![allow(
    clippy::unwrap_used,
    clippy::indexing_slicing,
    reason = "tests fail loudly on malformed fixtures"
)]

use binsight_core::units::{Decimals, Lamports};
use binsight_ledger::facts::UnpricedMovements;
use binsight_ledger::facts::*;
use binsight_ledger::report::figure::Figure;
use binsight_ledger::report::valued::{Money, MoneyUnit};
use binsight_solana::{Address, Signature};
use jiff::{Timestamp, tz::TimeZone};

use super::*;
use crate::portfolio::WalletLabel;
use crate::portfolio::snapshot::{SnapshotFacts, TrackedWallet};
use crate::portfolio::views::{SyncState, WalletColor, WalletSync};

fn id(opening: u8) -> PositionId {
    PositionId {
        address: Address::from_bytes([1; 32]),
        opened_by: Signature::from_bytes([opening; 64]),
    }
}

fn facts() -> SnapshotFacts {
    let wallet = Address::from_bytes([2; 32]);
    let now = Timestamp::from_second(86_400).unwrap();
    let token = |byte, kind| TokenFacts {
        mint: Address::from_bytes([byte; 32]),
        symbol: None,
        name: None,
        decimals: Decimals(6),
        kind,
    };
    let pool = PoolFacts {
        address: Address::from_bytes([3; 32]),
        bin_step: 80,
        base: token(4, TokenKind::Other),
        quote: token(5, TokenKind::Usdt),
    };
    let closed = |opening, method| ClosedPositionFacts {
        id: id(opening),
        wallet,
        pool: pool.address,
        strategy: Some(Strategy::Spot),
        opened_at: Timestamp::UNIX_EPOCH,
        closed_at: now,
        invested: QuoteUnits(100_000_000),
        withdrawn: QuoteUnits(110_000_000),
        claimed_fees: QuoteUnits(0),
        rewards: QuoteUnits(0),
        unpriced_rewards: 0,
        method,
        history: PositionHistory::Whole,
        unpriced_movements: UnpricedMovements::default(),
    };
    let tracked = TrackedWallet {
        facts: WalletFacts {
            address: wallet,
            added_at: Timestamp::UNIX_EPOCH,
            history: HistoryCoverage::Importing {
                indexed_since: None,
                progress: None,
            },
        },
        label: WalletLabel::short_address(&wallet),
        color: WalletColor::Wallet1,
        holdings: WalletHoldings {
            wallet,
            idle: Lamports(0),
            recoverable_rent: Lamports(0),
            unpriced: vec![],
            observed_at: now,
        },
        sync: WalletSync {
            state: SyncState::Live,
            lag_seconds: None,
            last_tx_at: None,
            indexed_tx: 0,
            import: None,
        },
    };
    let positions = vec![
        closed(6, PnlMethod::Pool),
        closed(
            7,
            PnlMethod::Fifo {
                market_pnl: QuoteUnits(-7_000_000),
            },
        ),
    ];
    SnapshotFacts {
        pools: vec![pool],
        wallets: vec![tracked],
        closed: positions,
        ..SnapshotFacts::default()
    }
}

fn context() -> ReadContext {
    ReadContext {
        now: Timestamp::from_second(86_400).unwrap(),
        timezone: TimeZone::UTC,
    }
}

#[test]
fn selects_the_exact_reopened_lifetime_and_preserves_its_method_before_fx() {
    let snapshot = Snapshot::new(facts()).unwrap();
    for (opening, amount) in [(6, 10_000_000), (7, -7_000_000)] {
        let request = PositionRequest {
            id: id(opening),
            currency: Currency::Sol,
        };
        let sol = position(&snapshot, request, &context()).unwrap();
        let usd = position(
            &snapshot,
            PositionRequest {
                currency: Currency::Usd,
                ..request
            },
            &context(),
        )
        .unwrap();
        assert_eq!(
            sol.native_pnl,
            Figure::Complete(Money {
                raw: amount,
                unit: MoneyUnit::Usdt
            })
        );
        assert_eq!(sol.native_pnl, usd.native_pnl);
        let PositionState::Closed(sol_row) = sol.position else {
            panic!("closed fixture")
        };
        let PositionState::Closed(usd_row) = usd.position else {
            panic!("closed fixture")
        };
        assert_eq!(sol_row.id, request.id);
        assert_eq!(usd_row.id, request.id);
        assert_eq!(
            sol_row.pnl.exactness(),
            binsight_core::exactness::Exactness::Unavailable
        );
        assert_eq!(usd_row.pnl.value().unwrap().raw, amount);
        assert_eq!(usd_row.lp_pnl.value().unwrap().raw, 10_000_000);
        assert_eq!(sol.chart, usd.chart);
    }
}

#[test]
fn copies_the_native_leaf_without_changing_the_closed_list_row_or_import_policy() {
    let snapshot = Snapshot::new(facts()).unwrap();
    for currency in [Currency::Sol, Currency::Usd] {
        for row in snapshot.closed_in(Scope::All) {
            let detail = position(
                &snapshot,
                PositionRequest {
                    id: row.facts.id,
                    currency,
                },
                &context(),
            )
            .unwrap();
            assert_eq!(detail.native_pnl, row.valuation.native_pnl);
            assert_eq!(
                detail.native_pnl.exactness(),
                binsight_core::exactness::Exactness::Complete
            );
            let PositionState::Closed(detail_row) = detail.position else {
                panic!("closed fixture")
            };
            assert_eq!(*detail_row, closed_row(&snapshot, row, currency).unwrap());
        }
    }
}

#[test]
fn preserves_unsupported_quote_unavailability_and_unknown_lifetime_errors() {
    let mut facts = facts();
    facts.pools[0].quote.kind = TokenKind::Other;
    let snapshot = Snapshot::new(facts).unwrap();
    let detail = position(
        &snapshot,
        PositionRequest {
            id: id(6),
            currency: Currency::Usd,
        },
        &context(),
    )
    .unwrap();
    assert_eq!(
        detail.native_pnl,
        Figure::unavailable(binsight_ledger::report::figure::Reason::UnsupportedQuote {
            pool: Address::from_bytes([3; 32])
        })
    );
    assert_eq!(
        position(
            &snapshot,
            PositionRequest {
                id: id(99),
                currency: Currency::Sol
            },
            &context()
        ),
        Err(ReadError::PositionNotFound(id(99)))
    );
}
