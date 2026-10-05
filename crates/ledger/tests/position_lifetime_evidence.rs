//! Raw evidence, missing dates and unavailable ownership survive independently of money valuation.
#[path = "common/lifetimes.rs"]
mod common;

use binsight_core::ratio::Percent;
use binsight_core::units::RawTokenAmount;
use binsight_dlmm::math::Q64x64;
use binsight_ledger::facts::{HistoryCoverage, PoolFacts, TokenFacts, TokenKind};
use binsight_ledger::positions::{
    LifetimeDiagnostic, LifetimeError, PositionLifetimes, RawActivityEvidence,
};
use common::*;

#[test]
fn refuses_a_book_context_for_missing_creation_without_inventing_a_foreign_owner_or_identity() {
    let mut replay = PositionLifetimes::new(context());
    let mut source = source(1, 10);
    source.activity.movements.push(movement(0, 20, 30));
    let ownership = replay.apply(&source).unwrap();
    assert_eq!(
        ownership.positions(),
        Err(LifetimeError::UnresolvedOwnership)
    );
    assert_eq!(
        ownership.diagnostics(),
        &[LifetimeDiagnostic::MissingCreation {
            position: POSITION,
            signature: source.transaction.signature
        }]
    );
    assert_eq!(source.transaction.fee.total.0, 5_000);
    let history = replay.finish();
    assert_eq!(history.lifetimes, Vec::new());
    assert_eq!(history.diagnostics, ownership.diagnostics());
}

#[test]
fn keeps_a_real_creation_and_closure_with_missing_dates_explicitly_unavailable() {
    let mut replay = PositionLifetimes::new(context());
    let mut opening = opening(1, 10);
    opening.transaction.block_time = None;
    replay.apply(&opening).unwrap();
    let mut closing = closing(2, 11);
    closing.transaction.block_time = None;
    replay.apply(&closing).unwrap();
    let history = replay.finish();
    let life = history.lifetimes.first().unwrap();
    assert_eq!(life.opened.at, None);
    assert_eq!(life.closed.unwrap().at, None);
    assert_eq!(life.raw_activity, RawActivityEvidence::Unknown);
    assert_eq!(history.diagnostics.len(), 2);
    assert!(
        history
            .diagnostics
            .iter()
            .all(|diagnostic| matches!(diagnostic, LifetimeDiagnostic::MissingBlockTime { .. }))
    );
}

#[test]
fn accepts_an_absent_timestamp_on_a_transaction_with_no_dated_position_fact() {
    let mut replay = PositionLifetimes::new(context());
    let mut source = source(1, 10);
    source.transaction.block_time = None;
    assert_eq!(replay.apply(&source).unwrap().diagnostics(), &[]);
    assert_eq!(replay.finish().diagnostics, Vec::new());
}

#[test]
fn proves_an_empty_shell_only_when_the_whole_life_is_covered_and_sources_are_contiguous() {
    let histories = [
        HistoryCoverage::Complete,
        HistoryCoverage::Importing {
            indexed_since: Some(time(10)),
            progress: Percent::ZERO,
        },
        HistoryCoverage::Importing {
            indexed_since: Some(time(11)),
            progress: Percent::ZERO,
        },
        HistoryCoverage::Importing {
            indexed_since: None,
            progress: Percent::ZERO,
        },
    ];
    for (index, history) in histories.into_iter().enumerate() {
        let mut context = context();
        context.history = history;
        let mut replay = PositionLifetimes::new(context);
        replay.apply(&opening(1, 10)).unwrap();
        replay.apply(&closing(2, 11)).unwrap();
        let evidence = replay.finish().lifetimes.first().unwrap().raw_activity;
        assert_eq!(
            evidence,
            if index < 2 {
                RawActivityEvidence::ProvenEmpty
            } else {
                RawActivityEvidence::Unknown
            }
        );
    }
    let mut context = context();
    context.sources_contiguous = false;
    let mut replay = PositionLifetimes::new(context);
    let ownership = replay.apply(&opening(1, 10)).unwrap();
    assert_eq!(
        ownership.positions(),
        Err(LifetimeError::UnresolvedOwnership)
    );
    let history = replay.finish();
    assert_eq!(
        history.lifetimes.first().unwrap().raw_activity,
        RawActivityEvidence::Unknown
    );
    assert!(
        history
            .diagnostics
            .contains(&LifetimeDiagnostic::NoncontiguousSources)
    );
}

#[test]
fn uses_the_injected_observation_boundary_for_an_open_empty_life() {
    let mut context = context();
    context.observed_at = time(9);
    let mut replay = PositionLifetimes::new(context);
    replay.apply(&opening(1, 10)).unwrap();
    let history = replay.finish();
    assert_eq!(
        history.lifetimes.first().unwrap().raw_activity,
        RawActivityEvidence::Unknown
    );
    assert!(matches!(
        history.diagnostics.last(),
        Some(LifetimeDiagnostic::InconsistentLifetimeDates { .. })
    ));
}

#[test]
fn preserves_unknown_activity_but_positive_gross_reward_or_liquidity_dominates_it() {
    for positive in [false, true] {
        let mut replay = PositionLifetimes::new(context());
        replay.apply(&opening(1, 10)).unwrap();
        let mut source = source(2, 11);
        source.activity.has_unknown_program_activity = true;
        if positive {
            source.activity.reward_claims.push(reward(0, 1));
        }
        replay.apply(&source).unwrap();
        let history = replay.finish();
        assert_eq!(
            history.lifetimes.first().unwrap().raw_activity,
            if positive {
                RawActivityEvidence::ObservedNonzero
            } else {
                RawActivityEvidence::Unknown
            }
        );
        assert!(history.diagnostics.iter().any(|diagnostic| matches!(
            diagnostic,
            LifetimeDiagnostic::UnknownProgramActivity { .. }
        )));
    }
}

#[test]
fn never_calls_a_positive_raw_movement_a_shell_when_its_quote_value_floors_to_zero() {
    let pool = PoolFacts {
        address: POOL,
        bin_step: 25,
        base: TokenFacts {
            mint: WALLET,
            symbol: None,
            name: None,
            decimals: binsight_core::units::Decimals(9),
            kind: TokenKind::Sol,
        },
        quote: TokenFacts {
            mint: FOREIGN,
            symbol: None,
            name: None,
            decimals: binsight_core::units::Decimals(9),
            kind: TokenKind::Other,
        },
    };
    let quoted = pool
        .quote_convention()
        .unwrap()
        .value_raw(
            RawTokenAmount(0),
            RawTokenAmount(1),
            Some(Q64x64(Q64x64::ONE.0 * 3)),
        )
        .unwrap();
    assert_eq!(quoted.amount, RawTokenAmount(0));
    let mut replay = PositionLifetimes::new(context());
    replay.apply(&opening(1, 10)).unwrap();
    let mut source = source(2, 11);
    source.activity.movements.push(movement(0, 0, 1));
    replay.apply(&source).unwrap();
    assert_eq!(
        replay.finish().lifetimes.first().unwrap().raw_activity,
        RawActivityEvidence::ObservedNonzero
    );
}

#[test]
fn reads_a_real_failed_close_without_an_economic_lifecycle_or_network_request() {
    let transaction = binsight_solana::transaction::read(include_bytes!(
        "../../../tests/fixtures/mainnet/failed-close/tx-1.json"
    ))
    .unwrap();
    let events = binsight_dlmm::decode_events(&transaction).unwrap();
    let activity = binsight_dlmm::position_activity(&transaction, &events).unwrap();
    assert_eq!(activity, binsight_dlmm::activity::TxActivity::default());
    let mut context = context();
    context.wallet = transaction.fee_payer;
    context.observed_at = transaction.block_time.unwrap();
    let source = binsight_ledger::positions::PositionTransaction {
        wallet: transaction.fee_payer,
        order: transaction
            .transaction_index
            .map(|index| binsight_ledger::positions::TransactionOrderProof::Canonical { index }),
        transaction,
        activity,
    };
    let mut replay = PositionLifetimes::new(context);
    replay.apply(&source).unwrap();
    assert_eq!(replay.finish().lifetimes, Vec::new());
}

#[test]
fn refuses_economic_activity_supplied_with_failed_execution() {
    let mut replay = PositionLifetimes::new(context());
    let mut source = opening(1, 10);
    source.transaction.outcome = binsight_solana::transaction::TxOutcome::Failed {
        error: "{}".to_owned(),
    };
    assert_eq!(
        replay.apply(&source),
        Err(LifetimeError::FailedTransactionActivity)
    );
    assert_eq!(replay.finish().lifetimes, Vec::new());
}
