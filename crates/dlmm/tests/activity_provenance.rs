//! Mixed source provenance and missing claim scope, independent of dated financial facts.

mod common;
#[path = "activity_provenance/fixtures.rs"]
mod fixtures;

use binsight_dlmm::activity::{
    ActivityProvenanceError, ActivityRef, ClaimKind, EventEffect, derive_position_activity,
    position_activity,
};
use binsight_dlmm::event::{EventName, decode_events};
use binsight_solana::transaction::{InstructionData, TxOutcome};
use common::{address, dlmm_instruction, every_fixture, fixture, transaction};
use fixtures::{add, close, create, fee, rebalance, reward, without_scope};

#[test]
fn binds_mixed_rows_to_the_exact_consumed_transaction() {
    let tx = transaction(
        vec![create(0), reward((1, 0), 11), add(2, 13), close(3)],
        Vec::new(),
    );
    let events = decode_events(&tx).unwrap();
    let expected = position_activity(&tx, &events).unwrap();
    let derived = derive_position_activity(tx.clone()).unwrap();
    assert_eq!(derived.transaction(), &tx);
    assert_eq!(derived.events(), events);
    assert_eq!(derived.activity(), &expected);
    let rows: Vec<_> = derived
        .origins()
        .iter()
        .map(|row| {
            (
                row.row(),
                row.source().decoded_event_index(),
                row.source().at(),
            )
        })
        .collect();
    assert_eq!(
        rows,
        [
            (ActivityRef::Lifecycle { index: 0 }, 0, events[0].at),
            (ActivityRef::RewardClaim { index: 0 }, 1, events[1].at),
            (ActivityRef::Movement { index: 0 }, 2, events[2].at),
            (ActivityRef::Lifecycle { index: 1 }, 3, events[3].at),
        ]
    );
}

#[test]
fn names_five_effects_of_one_rebalance_without_inventing_emissions() {
    let derived = derive_position_activity(transaction(
        vec![rebalance(0, [5, 7, 4, 6, 2, 3], [11, 22])],
        Vec::new(),
    ))
    .unwrap();
    assert_eq!(derived.events().len(), 1);
    assert_eq!(
        derived
            .origins()
            .iter()
            .map(|row| row.row())
            .collect::<Vec<_>>(),
        [
            ActivityRef::Movement { index: 0 },
            ActivityRef::Movement { index: 1 },
            ActivityRef::Movement { index: 2 },
            ActivityRef::RewardClaim { index: 0 },
            ActivityRef::RewardClaim { index: 1 },
        ]
    );
    let effects: Vec<_> = derived
        .origins()
        .iter()
        .map(|row| (row.source().decoded_event_index(), row.effect()))
        .collect();
    assert_eq!(
        effects,
        [
            (0, EventEffect::RebalanceWithdrawal),
            (0, EventEffect::RebalanceDeposit),
            (0, EventEffect::RebalanceFees),
            (0, EventEffect::RebalanceReward0),
            (0, EventEffect::RebalanceReward1),
        ]
    );
    assert_eq!(derived.diagnostics(), []);
}

#[test]
fn keeps_only_nonzero_rebalance_effects_but_preserves_a_zero_add() {
    let derived = derive_position_activity(transaction(
        vec![rebalance(0, [0; 6], [0, 9]), add(1, 0)],
        Vec::new(),
    ))
    .unwrap();
    let rows: Vec<_> = derived
        .origins()
        .iter()
        .map(|row| (row.row(), row.effect()))
        .collect();
    assert_eq!(
        rows,
        [
            (
                ActivityRef::RewardClaim { index: 0 },
                EventEffect::RebalanceReward1
            ),
            (ActivityRef::Movement { index: 0 }, EventEffect::Single)
        ]
    );
}

#[test]
fn prefers_the_actual_second_form_source_in_either_emission_order() {
    for forms in [
        [EventName::ClaimFee, EventName::ClaimFee2],
        [EventName::ClaimFee2, EventName::ClaimFee],
    ] {
        let tx = transaction(
            vec![
                dlmm_instruction(0, "claim_fee2", vec![address(1), address(2)]),
                fee(forms[0], (0, 0), 7),
                fee(forms[1], (0, 1), 7),
            ],
            Vec::new(),
        );
        let derived = derive_position_activity(tx).unwrap();
        let second = u32::try_from(
            forms
                .iter()
                .position(|&form| form == EventName::ClaimFee2)
                .unwrap(),
        )
        .unwrap();
        assert_eq!(derived.origins().len(), 1);
        assert_eq!(derived.origins()[0].source().decoded_event_index(), second);
        assert_eq!(derived.diagnostics(), []);
    }
}

#[test]
fn keeps_equal_claims_from_two_proved_paying_instructions() {
    let tx = transaction(
        vec![
            dlmm_instruction(0, "claim_fee2", vec![address(1), address(2)]),
            fee(EventName::ClaimFee2, (0, 0), 7),
            dlmm_instruction(1, "claim_fee2", vec![address(1), address(2)]),
            fee(EventName::ClaimFee2, (1, 0), 7),
        ],
        Vec::new(),
    );
    let derived = derive_position_activity(tx).unwrap();
    assert_eq!(derived.origins().len(), 2);
    assert_eq!(derived.diagnostics(), []);
}

#[test]
fn diagnoses_positive_dedup_without_scope_but_accepts_a_unique_claim() {
    let unique = without_scope(fee(EventName::ClaimFee2, (0, 0), 7));
    let tx = transaction(vec![unique.clone()], Vec::new());
    let accepted = derive_position_activity(tx).unwrap();
    assert_eq!(accepted.diagnostics(), []);
    assert_eq!(accepted.origins().len(), 1);
    assert_eq!(accepted.activity().movements[0].y.0, 7);
    let tx = transaction(
        vec![unique, without_scope(fee(EventName::ClaimFee2, (1, 0), 7))],
        Vec::new(),
    );
    let derived = derive_position_activity(tx).unwrap();
    assert_eq!(derived.origins().len(), 1);
    let diagnostic = derived.diagnostics()[0];
    assert_eq!(diagnostic.kind(), ClaimKind::Fee);
    assert_eq!(diagnostic.position(), address(2));
    assert_eq!(diagnostic.suppressed().decoded_event_index(), 1);
    assert_eq!(diagnostic.representative().decoded_event_index(), 0);
}

#[test]
fn diagnoses_a_first_form_suppressed_by_an_unscoped_second_form() {
    let tx = transaction(
        vec![
            without_scope(fee(EventName::ClaimFee, (0, 0), 7)),
            without_scope(fee(EventName::ClaimFee2, (1, 0), 7)),
        ],
        Vec::new(),
    );
    let derived = derive_position_activity(tx).unwrap();
    assert_eq!(derived.origins()[0].source().decoded_event_index(), 1);
    assert_eq!(
        derived.diagnostics()[0].suppressed().decoded_event_index(),
        0
    );
    assert_eq!(
        derived.diagnostics()[0]
            .representative()
            .decoded_event_index(),
        1
    );
}

#[test]
fn diagnoses_a_rebalance_harvest_suppressed_without_scope() {
    let tx = transaction(
        vec![
            without_scope(rebalance(0, [0, 0, 0, 0, 0, 7], [0; 2])),
            without_scope(fee(EventName::ClaimFee2, (1, 0), 7)),
        ],
        Vec::new(),
    );
    let derived = derive_position_activity(tx).unwrap();
    assert_eq!(derived.origins().len(), 1);
    assert_eq!(derived.diagnostics().len(), 1);
    assert_eq!(
        derived.diagnostics()[0].suppressed().decoded_event_index(),
        0
    );
}

#[test]
fn diagnoses_reward_duplicates_without_pricing_or_resolving_their_mint() {
    let tx = transaction(
        vec![
            without_scope(reward((0, 0), 11)),
            without_scope(reward((1, 0), 11)),
        ],
        Vec::new(),
    );
    let derived = derive_position_activity(tx).unwrap();
    assert_eq!(derived.diagnostics()[0].kind(), ClaimKind::Reward);
    assert_eq!(derived.activity().reward_claims[0].mint, None);
}

#[test]
fn does_not_invent_uncertain_costs_from_a_zero_claim() {
    let tx = transaction(
        vec![
            without_scope(fee(EventName::ClaimFee2, (0, 0), 0)),
            without_scope(fee(EventName::ClaimFee2, (1, 0), 0)),
        ],
        Vec::new(),
    );
    let derived = derive_position_activity(tx).unwrap();
    assert_eq!(derived.diagnostics(), []);
}

#[test]
fn preserves_failed_emissions_without_economic_origins() {
    let tx = fixture("failed-close", 0);
    assert!(matches!(tx.outcome, TxOutcome::Failed { .. }));
    let derived = derive_position_activity(tx).unwrap();
    assert_ne!(derived.events(), []);
    assert_eq!(derived.origins(), []);
    assert_eq!(derived.diagnostics(), []);
}

#[test]
fn keeps_legacy_activity_exact_on_the_existing_transaction_corpus() {
    for (_, tx) in every_fixture() {
        let events = decode_events(&tx).unwrap();
        let legacy = position_activity(&tx, &events);
        match derive_position_activity(tx) {
            Ok(derived) => assert_eq!(legacy.unwrap(), *derived.activity()),
            Err(ActivityProvenanceError::Activity(error)) => assert_eq!(legacy.unwrap_err(), error),
            Err(error) => panic!("unexpected error: {error}"),
        }
    }
}

#[test]
fn returns_a_typed_decode_error_without_a_partial_derivation() {
    let mut malformed = fee(EventName::ClaimFee2, (0, 0), 7);
    malformed.data = InstructionData(malformed.data.0[..16].to_vec());
    assert!(matches!(
        derive_position_activity(transaction(vec![malformed], Vec::new())),
        Err(ActivityProvenanceError::Decode(_))
    ));
}

#[test]
fn retains_unknown_activity_without_inventing_a_position_effect() {
    let mut unknown = common::event_call(0, 0, 2);
    unknown.data.0.extend_from_slice(&[7; 8]);
    let derived = derive_position_activity(transaction(vec![unknown], Vec::new())).unwrap();
    assert!(derived.activity().has_unknown_program_activity);
    assert_eq!(derived.events().len(), 1);
    assert_eq!(derived.origins(), []);
}
