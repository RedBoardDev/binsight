//! Large immutable snapshots and local-day windows keep their pagination and totals.

#![allow(
    clippy::unwrap_used,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects,
    reason = "tests fail loudly"
)]

use std::collections::BTreeSet;

use binsight_core::units::{Decimals, Lamports};
use binsight_ledger::facts::{
    ClosedPositionFacts, HistoryCoverage, PnlMethod, PoolFacts, PositionId, QuoteUnits, Strategy,
    TokenFacts, TokenKind, WalletFacts, WalletHoldings,
};
use binsight_ledger::report::period::Window;
use binsight_solana::{Address, Signature};
use jiff::tz::TimeZone;
use jiff::{SignedDuration, Timestamp};

use super::*;
use crate::portfolio::query::{ClosedPageRequest, ClosedQuery, closed_page};
use crate::portfolio::snapshot::{SnapshotFacts, TrackedWallet};
use crate::portfolio::views::{SyncState, WalletColor, WalletSync};
use crate::portfolio::wallet_label::WalletLabel;
use crate::portfolio::{ReadContext, Scope, Snapshot};

fn snapshot_with_strategy(count: u32, strategy: Option<Strategy>) -> Snapshot {
    snapshot_with_facts(count, strategy, false)
}

fn snapshot_with_facts(count: u32, strategy: Option<Strategy>, unknown: bool) -> Snapshot {
    let address = Address::from_bytes([7; 32]);
    let wallet = TrackedWallet {
        facts: WalletFacts {
            address,
            added_at: Timestamp::UNIX_EPOCH,
            history: HistoryCoverage::Complete,
        },
        label: WalletLabel::short_address(&address),
        color: WalletColor::Wallet1,
        holdings: WalletHoldings {
            wallet: address,
            idle: Lamports(0),
            recoverable_rent: Lamports(0),
            unpriced: Vec::new(),
            observed_at: Timestamp::UNIX_EPOCH,
        },
        sync: WalletSync {
            state: SyncState::Live,
            lag_seconds: None,
            last_tx_at: None,
            indexed_tx: 0,
            import: None,
        },
    };
    let token = |byte| TokenFacts {
        mint: Address::from_bytes([byte; 32]),
        symbol: None,
        name: None,
        decimals: Decimals(9),
        kind: TokenKind::Sol,
    };
    let pool = PoolFacts {
        address: Address::from_bytes([3; 32]),
        bin_step: 80,
        base: token(4),
        quote: token(5),
    };
    let closed = (0..count)
        .map(|index| {
            let mut bytes = [0; 64];
            bytes[..4].copy_from_slice(&index.to_be_bytes());
            ClosedPositionFacts {
                id: PositionId {
                    address,
                    opened_by: Signature::from_bytes(bytes),
                },
                wallet: address,
                pool: pool.address,
                strategy,
                opened_at: Timestamp::UNIX_EPOCH,
                closed_at: Timestamp::from_second(i64::from(index) * 600).unwrap(),
                invested: QuoteUnits(100),
                withdrawn: QuoteUnits(105),
                claimed_fees: QuoteUnits(0),
                rewards: QuoteUnits(0),
                unpriced_rewards: 0,
                method: PnlMethod::Pool,
                unpriced_movements: u32::from(unknown),
                unpriced_rebalances: 0,
            }
        })
        .collect();
    Snapshot::new(SnapshotFacts {
        wallets: vec![wallet],
        pools: vec![pool],
        closed,
        ..SnapshotFacts::default()
    })
    .unwrap()
}

fn snapshot(count: u32) -> Snapshot {
    snapshot_with_strategy(count, Some(Strategy::Spot))
}

fn query() -> ClosedQuery {
    ClosedQuery {
        scope: Scope::All,
        day: None,
        search: None,
        outcomes: BTreeSet::new(),
        strategies: BTreeSet::new(),
        pools: BTreeSet::new(),
        sort: ClosedSort::ClosedAt,
        order: SortOrder::Descending,
        currency: Currency::Sol,
    }
}

#[test]
fn pages_fifty_thousand_closes_without_a_gap_or_changing_day_totals() {
    let snapshot = snapshot(50_000);
    let context = ReadContext {
        now: Timestamp::from_second(50_000 * 600).unwrap(),
        timezone: TimeZone::UTC,
    };
    let query = query();
    let mut after = None;
    let mut expected_second = 49_999;
    let mut count = 0;
    loop {
        let page = closed_page(
            &snapshot,
            &query,
            ClosedPageRequest {
                as_of: None,
                after,
                limit: 200,
            },
            &context,
        )
        .unwrap();
        assert_eq!(page.matched_count, 50_000);
        for group in page.day_groups.as_ref().unwrap() {
            let midnight =
                binsight_ledger::report::period::midnight(group.day, &TimeZone::UTC).unwrap();
            let first_index = midnight.as_second() / 600;
            let expected_count = usize::try_from((50_000 - first_index).min(144)).unwrap();
            assert_eq!(group.count, expected_count);
        }
        for row in page.items {
            assert_eq!(row.closed_at.as_second(), expected_second * 600);
            expected_second -= 1;
            count += 1;
        }
        after = page.next;
        if after.is_none() {
            break;
        }
        assert!(count < 50_000);
    }
    assert_eq!(count, 50_000);
}

#[test]
fn counts_a_close_at_the_snapshot_instant_in_its_day_group() {
    let snapshot = snapshot(2);
    let context = ReadContext {
        now: Timestamp::from_second(600).unwrap(),
        timezone: TimeZone::UTC,
    };
    let page = closed_page(
        &snapshot,
        &query(),
        ClosedPageRequest {
            as_of: None,
            after: None,
            limit: 1,
        },
        &context,
    )
    .unwrap();

    assert_eq!(page.matched_count, 2);
    assert_eq!(page.day_groups.unwrap()[0].count, 2);
}

#[test]
fn keeps_day_windows_exact_in_half_hour_zones() {
    let snapshot = snapshot(20_000);
    let context = ReadContext {
        now: Timestamp::from_second(20_000 * 600).unwrap(),
        timezone: TimeZone::get("America/St_Johns").unwrap(),
    };
    let page = closed_page(
        &snapshot,
        &query(),
        ClosedPageRequest {
            as_of: None,
            after: None,
            limit: 1,
        },
        &context,
    )
    .unwrap();
    let group = &page.day_groups.as_ref().unwrap()[0];
    let expected = snapshot
        .closed_in(Scope::All)
        .filter(|row| {
            row.facts
                .closed_at
                .to_zoned(context.timezone.clone())
                .date()
                == group.day
        })
        .count();

    assert_eq!(group.count, expected);
    assert!(expected < 20_000);
    let window = Window::of_day(
        group.day,
        context
            .now
            .checked_add(SignedDuration::from_hours(24))
            .unwrap(),
        &context.timezone,
    )
    .unwrap();
    assert_eq!(snapshot.closed_during(&window).count(), expected);
}

#[test]
fn includes_unknown_strategy_without_a_filter_but_never_claims_it_is_spot() {
    let snapshot = snapshot_with_strategy(1, None);
    let context = ReadContext {
        now: Timestamp::UNIX_EPOCH,
        timezone: TimeZone::UTC,
    };
    let request = ClosedPageRequest {
        as_of: None,
        after: None,
        limit: 200,
    };
    let mut query = query();
    let page = closed_page(&snapshot, &query, request, &context).unwrap();
    assert_eq!(page.matched_count, 1);
    assert_eq!(page.items[0].strategy, None);
    query.strategies.insert(Strategy::Spot);
    let page = closed_page(&snapshot, &query, request, &context).unwrap();
    assert_eq!(page.matched_count, 0);
    assert_eq!(page.items.len(), 0);
}

#[test]
fn pages_unclassified_lives_without_including_them_in_explicit_outcomes() {
    use binsight_ledger::report::closed::Outcome;
    let snapshot = snapshot_with_facts(3, Some(Strategy::Spot), true);
    let context = ReadContext {
        now: Timestamp::from_second(1800).unwrap(),
        timezone: TimeZone::UTC,
    };
    let mut query = query();
    let mut after = None;
    let mut ids = BTreeSet::new();
    loop {
        let page = closed_page(
            &snapshot,
            &query,
            ClosedPageRequest {
                as_of: None,
                after,
                limit: 1,
            },
            &context,
        )
        .unwrap();
        assert_eq!(page.matched_count, 3);
        assert_eq!(page.day_groups.as_ref().unwrap()[0].unclassified_count, 3);
        assert_eq!(page.items[0].outcome, None);
        assert!(ids.insert(page.items[0].id));
        after = page.next;
        if after.is_none() {
            break;
        }
    }
    assert_eq!(ids.len(), 3);
    for outcome in [Outcome::Win, Outcome::Loss, Outcome::Flat] {
        query.outcomes = BTreeSet::from([outcome]);
        let page = closed_page(
            &snapshot,
            &query,
            ClosedPageRequest {
                as_of: None,
                after: None,
                limit: 1,
            },
            &context,
        )
        .unwrap();
        assert_eq!(page.matched_count, 0);
        assert_eq!(page.total_count, 3);
        assert_eq!(page.items, Vec::new());
    }
}
