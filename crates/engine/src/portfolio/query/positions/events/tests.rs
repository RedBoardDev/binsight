//! Regression coverage for chain-ordered keyset pagination.

#![allow(
    clippy::unwrap_used,
    clippy::indexing_slicing,
    reason = "tests fail loudly on malformed fixtures"
)]

use binsight_core::units::{Decimals, RawTokenAmount};
use binsight_ledger::facts::{
    ChainOrder, ClosedPositionFacts, PnlMethod, PositionEventKind, QuoteUnits, Strategy,
    TokenFacts, TokenFlow, TokenKind,
};
use binsight_solana::{Address, Signature};
use jiff::SignedDuration;

use super::*;
use crate::portfolio::snapshot::SnapshotFacts;

fn snapshot_facts(events: Vec<PositionEventFact>) -> SnapshotFacts {
    let id = events[0].position;
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
    SnapshotFacts {
        pools: vec![pool.clone()],
        closed: vec![ClosedPositionFacts {
            id,
            wallet: Address::from_bytes([6; 32]),
            pool: pool.address,
            strategy: Some(Strategy::Spot),
            opened_at: jiff::Timestamp::UNIX_EPOCH,
            closed_at: jiff::Timestamp::UNIX_EPOCH,
            invested: QuoteUnits(0),
            withdrawn: QuoteUnits(0),
            claimed_fees: QuoteUnits(0),
            rewards: QuoteUnits(0),
            unpriced_rewards: 0,
            method: PnlMethod::Pool,
            unpriced_movements: 0,
            unpriced_rebalances: 0,
        }],
        events,
        ..SnapshotFacts::default()
    }
}

fn snapshot(events: Vec<PositionEventFact>) -> Snapshot {
    Snapshot::new(snapshot_facts(events)).unwrap()
}

fn movement(transaction_index: u32, event_index: u32) -> PositionEventFact {
    PositionEventFact {
        position: PositionId {
            address: Address::from_bytes([1; 32]),
            opened_by: Signature::from_bytes([2; 64]),
        },
        at: jiff::Timestamp::UNIX_EPOCH,
        order: ChainOrder {
            slot: 7,
            transaction_index,
            event_index,
        },
        signature: Signature::from_bytes([200; 64]),
        active_bin_id: None,
        kind: PositionEventKind::Claim(TokenFlow {
            base: RawTokenAmount(5),
            quote: RawTokenAmount(7),
            value: QuoteUnits(12),
            valuation: binsight_ledger::facts::FlowValuation::Complete,
        }),
    }
}

fn read_every_movement(
    snapshot: &Snapshot,
    limit: usize,
    currency: Currency,
) -> Vec<PositionEventView> {
    let id = snapshot
        .closed_in(crate::portfolio::Scope::All)
        .next()
        .unwrap()
        .facts
        .id;
    let mut items = Vec::new();
    let mut after = None;
    loop {
        let page = position_events(
            snapshot,
            EventPageRequest {
                id,
                after,
                limit,
                currency,
            },
        )
        .unwrap();
        items.extend(page.items);
        after = page.next;
        if after.is_none() {
            return items;
        }
        assert!(items.len() < 10, "pagination must progress");
    }
}

#[test]
fn pages_every_same_second_movement_and_equal_claim_without_skipping() {
    let mut add = movement(1, 0);
    add.kind = PositionEventKind::Add(add.kind.flow().unwrap());
    let mut claim = movement(2, 0);
    claim.signature = Signature::from_bytes([2; 64]);
    let mut equal_claim = claim.clone();
    equal_claim.order.event_index = 1;
    let snapshot = snapshot(vec![equal_claim, add, claim]);

    let whole = read_every_movement(&snapshot, 200, Currency::Sol);
    assert_eq!(whole.len(), 3);
    assert_eq!(read_every_movement(&snapshot, 1, Currency::Sol), whole);
    assert_eq!(whole[0].order.chain.event_index, 1);
    assert_eq!(whole[2].kind, MovementKind::Add);
}

#[test]
fn follows_the_chain_even_when_block_times_run_backwards() {
    let mut earlier = movement(1, 0);
    earlier.at = earlier
        .at
        .checked_add(SignedDuration::from_secs(1))
        .unwrap();
    let newer = movement(2, 0);
    let snapshot = snapshot(vec![newer, earlier]);

    let items = read_every_movement(&snapshot, 1, Currency::Sol);
    assert_eq!(items[0].order.chain.transaction_index, 2);
    assert_eq!(items[1].order.chain.transaction_index, 1);
}

#[test]
fn keeps_both_movements_when_synthetic_transaction_indices_collide() {
    let first = movement(1, 0);
    let mut second = first.clone();
    second.signature = Signature::from_bytes([201; 64]);
    let snapshot = snapshot(vec![first, second]);

    let whole = read_every_movement(&snapshot, 200, Currency::Sol);
    assert_eq!(whole.len(), 2);
    assert_eq!(read_every_movement(&snapshot, 1, Currency::Sol), whole);
}

#[test]
fn pages_full_rebalance_transfers_with_net_header_values_in_both_currencies() {
    use binsight_core::money::SolUsdRate;
    use binsight_ledger::facts::{QuoteAsset, RebalanceFlow};
    use binsight_ledger::report::valued::value_quote;
    use binsight_solana::transaction::InstructionPosition;

    let mut events = Vec::new();
    for (index, (deposit, withdrawal)) in [(100, 100), (104, 100), (100, 103), (104, 100)]
        .into_iter()
        .enumerate()
    {
        let top = u16::try_from(index).unwrap();
        let order = u32::try_from(index * 2).unwrap();
        let half = |amount| RebalanceFlow {
            instruction: InstructionPosition {
                top,
                inner: Some(0),
            },
            flow: TokenFlow {
                base: RawTokenAmount(50),
                quote: RawTokenAmount(70),
                value: QuoteUnits(amount),
                valuation: binsight_ledger::facts::FlowValuation::Complete,
            },
        };
        let mut removed = movement(1, order);
        removed.kind = PositionEventKind::RebalanceWithdrawal(half(withdrawal));
        let mut added = movement(1, order + 1);
        added.kind = PositionEventKind::RebalanceDeposit {
            movement: half(deposit),
            range: None,
        };
        events.extend([removed, added]);
    }
    let rate = SolUsdRate::new(333_333_333).unwrap();
    for (asset, token_kind, decimals) in [
        (QuoteAsset::Sol, TokenKind::Sol, Decimals::SOL),
        (QuoteAsset::Usdc, TokenKind::Usdc, Decimals(6)),
    ] {
        let mut facts = snapshot_facts(events.clone());
        facts.pools[0].quote.kind = token_kind;
        facts.pools[0].quote.decimals = decimals;
        facts.closed[0].invested = QuoteUnits(8);
        facts.closed[0].withdrawn = QuoteUnits(3);
        facts.rates.daily.insert(
            jiff::Timestamp::UNIX_EPOCH
                .to_zoned(jiff::tz::TimeZone::UTC)
                .date(),
            rate,
        );
        let snapshot = Snapshot::new(facts).unwrap();
        for currency in [Currency::Sol, Currency::Usd] {
            let whole = read_every_movement(&snapshot, 200, currency);
            assert_eq!(whole.len(), 8);
            assert_eq!(read_every_movement(&snapshot, 1, currency), whole);
            for event in &whole {
                assert_eq!(event.base.unwrap().amount, RawTokenAmount(50));
                assert_eq!(event.quote.unwrap().amount, RawTokenAmount(70));
            }
            for (kind, expected) in [
                (MovementKind::RebalanceDeposit, 8),
                (MovementKind::RebalanceWithdrawal, 3),
            ] {
                let sum: i128 = whole
                    .iter()
                    .filter(|event| event.kind == kind)
                    .map(|event| event.value.as_ref().unwrap().value().unwrap().raw)
                    .sum();
                let figure = resolve(
                    &value_quote(QuoteUnits(expected), asset, Some(rate)).unwrap(),
                    currency,
                );
                assert_eq!(sum, figure.value().unwrap().raw);
            }
        }
    }
}

#[test]
fn preserves_an_unpriced_reward_without_assuming_its_decimals() {
    use binsight_ledger::facts::RewardFlow;
    let mut reward = movement(1, 0);
    reward.active_bin_id = Some(1);
    reward.kind = PositionEventKind::RewardClaim(RewardFlow {
        mint: Address::from_bytes([9; 32]),
        amount: RawTokenAmount(u128::MAX),
        reward_index: 1,
        value: None,
    });
    let mut facts = snapshot_facts(vec![reward]);
    facts.closed[0].unpriced_rewards = 1;
    let snapshot = Snapshot::new(facts).unwrap();
    let items = read_every_movement(&snapshot, 1, Currency::Sol);
    let item = &items[0];
    assert_eq!(item.kind, MovementKind::RewardClaim);
    assert!(item.base.is_none() && item.quote.is_none());
    assert_eq!(item.reward.unwrap().raw_amount, RawTokenAmount(u128::MAX));
    assert_eq!(
        item.value.as_ref().unwrap().exactness(),
        binsight_core::exactness::Exactness::Unavailable
    );
    assert!(
        !snapshot
            .closed_in(crate::portfolio::Scope::All)
            .next()
            .unwrap()
            .valuation
            .is_shell
    );
}

#[test]
fn serves_empty_lifecycle_events_without_inventing_a_deposit_or_range() {
    let mut created = movement(1, 0);
    created.kind = PositionEventKind::Created { range: None };
    let mut closed = movement(2, 0);
    closed.kind = PositionEventKind::Closed;
    let snapshot = snapshot(vec![closed, created]);
    let items = read_every_movement(&snapshot, 1, Currency::Sol);
    assert_eq!(items[0].kind, MovementKind::Close);
    assert_eq!(items[1].kind, MovementKind::Open);
    for item in items {
        assert!(
            item.base.is_none()
                && item.quote.is_none()
                && item.value.is_none()
                && item.range.is_none()
        );
    }
    assert!(
        snapshot
            .closed_in(crate::portfolio::Scope::All)
            .next()
            .unwrap()
            .valuation
            .is_shell
    );
}

#[test]
fn estimates_both_rebalance_halves_when_the_unknown_base_can_reverse_its_net() {
    use binsight_core::exactness::Exactness;
    use binsight_ledger::facts::{FlowValuation, RebalanceFlow};
    use binsight_solana::transaction::InstructionPosition;
    let half = |base, quote| RebalanceFlow {
        instruction: InstructionPosition {
            top: 1,
            inner: Some(0),
        },
        flow: TokenFlow {
            base: RawTokenAmount(base),
            quote: RawTokenAmount(quote),
            value: QuoteUnits(i128::try_from(quote).unwrap()),
            valuation: FlowValuation::QuoteOnly,
        },
    };
    let mut added = movement(1, 1);
    added.kind = PositionEventKind::RebalanceDeposit {
        movement: half(10, 104),
        range: None,
    };
    let mut removed = movement(1, 0);
    removed.kind = PositionEventKind::RebalanceWithdrawal(half(50, 100));
    let mut facts = snapshot_facts(vec![added, removed]);
    facts.closed[0].invested = QuoteUnits(4);
    facts.closed[0].unpriced_movements = 2;
    facts.closed[0].unpriced_rebalances = 1;
    let snapshot = Snapshot::new(facts).unwrap();
    let items = read_every_movement(&snapshot, 1, Currency::Sol);
    for item in &items {
        assert_eq!(
            item.value.as_ref().unwrap().exactness(),
            Exactness::Estimated
        );
    }
    assert_eq!(items[0].value.as_ref().unwrap().value().unwrap().raw, 4);
    // At one quote unit per raw base unit, the real net is (104+10)-(100+50) = -36.
    let actual_deposited = 104_i128.checked_add(10).unwrap();
    let actual_withdrawn = 100_i128.checked_add(50).unwrap();
    assert_eq!(actual_deposited.checked_sub(actual_withdrawn).unwrap(), -36);
    let valuation = &snapshot
        .closed_in(crate::portfolio::Scope::All)
        .next()
        .unwrap()
        .valuation;
    assert_eq!(valuation.invested.exactness(), Exactness::Estimated);
    assert_eq!(valuation.withdrawn.exactness(), Exactness::Estimated);
}

#[test]
fn follows_flow_quality_instead_of_inferring_it_from_missing_bin_metadata() {
    use binsight_core::exactness::Exactness;
    use binsight_ledger::facts::FlowValuation;
    let mut full = movement(1, 0);
    full.active_bin_id = None;
    let mut quote_only = movement(1, 1);
    let PositionEventKind::Claim(flow) = &mut quote_only.kind else {
        panic!("expected claim fixture")
    };
    flow.value = QuoteUnits(7);
    flow.valuation = FlowValuation::QuoteOnly;
    let snapshot = snapshot(vec![full, quote_only]);
    let items = read_every_movement(&snapshot, 1, Currency::Sol);
    assert_eq!(
        items[0].value.as_ref().unwrap().exactness(),
        Exactness::Partial
    );
    assert_eq!(
        items[1].value.as_ref().unwrap().exactness(),
        Exactness::Complete
    );
}
