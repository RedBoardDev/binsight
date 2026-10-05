//! Mainnet records preserve execution outcomes and provenance without inventing successful reads.

use super::*;
use binsight_solana::{Signature, transaction::TxOutcome};
use binsight_store::PayloadCompression;

fn fixture(name: &str) -> (RawTxRecord, Vec<u8>) {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../tests/fixtures/mainnet")
        .join(name)
        .join("tx-1.json");
    let payload = std::fs::read(path).unwrap();
    let tx = read(&payload).unwrap();
    let raw = RawTxRecord {
        signature: tx.signature,
        slot: tx.slot,
        block_time: tx.block_time,
        tx_version: tx.version,
        commitment: Commitment::Finalized,
        encoding: TxEncoding::Base64,
        compression: PayloadCompression::None,
        payload: payload.clone(),
        payload_sha256: [0; 32],
        fetched_at: Timestamp::UNIX_EPOCH,
    };
    (raw, payload)
}

#[test]
fn retains_a_failed_close_emission_without_claiming_any_lifecycle_activity() {
    let (raw, payload) = fixture("failed-close");
    let record = decode(&raw, &payload, Timestamp::UNIX_EPOCH);
    assert!(matches!(
        record.execution_outcome,
        Some(TxOutcome::Failed { .. })
    ));
    let DecodeOutcome::Decoded(events) = record.outcome else {
        panic!("failed execution is not failed decoding")
    };
    assert!(
        events
            .iter()
            .any(|event| event.kind == "dlmm.position_close")
    );
    let tx = read(&payload).unwrap();
    let activity =
        binsight_dlmm::position_activity(&tx, &binsight_dlmm::decode_events(&tx).unwrap()).unwrap();
    assert_eq!(activity, binsight_dlmm::TxActivity::default());
}

#[test]
fn stores_each_event_at_its_actual_instruction_with_amount_strings() {
    let (raw, payload) = fixture("rebalance-with-fees");
    let record = decode(&raw, &payload, Timestamp::UNIX_EPOCH);
    assert_eq!(record.execution_outcome, Some(TxOutcome::Succeeded));
    let DecodeOutcome::Decoded(stored) = record.outcome else {
        panic!("expected events")
    };
    let located = binsight_dlmm::decode_events(&read(&payload).unwrap()).unwrap();
    assert_eq!(stored.len(), located.len());
    for (stored, located) in stored.iter().zip(located) {
        let json: serde_json::Value = serde_json::from_str(&stored.payload_json).unwrap();
        assert_eq!(json["at"]["top"], located.at.top);
        assert_eq!(
            json["at"]["inner"],
            serde_json::to_value(located.at.inner).unwrap()
        );
        assert_eq!(json["event"], serde_json::to_value(located.event).unwrap());
        assert_eq!(stored.kind, format!("dlmm.{}", located.event.kind()));
    }
}

#[test]
fn distinguishes_a_plain_wallet_transfer_from_an_unreadable_execution_result() {
    let (raw, payload) = fixture("legacy-sol-transfer");
    let transfer = decode(&raw, &payload, Timestamp::UNIX_EPOCH);
    assert_eq!(transfer.execution_outcome, Some(TxOutcome::Succeeded));
    assert_eq!(transfer.outcome, DecodeOutcome::NotApplicable);
    let mut json: serde_json::Value = serde_json::from_slice(&payload).unwrap();
    json["meta"].as_object_mut().unwrap().remove("err");
    let unreadable = decode(
        &raw,
        &serde_json::to_vec(&json).unwrap(),
        Timestamp::UNIX_EPOCH,
    );
    assert_eq!(unreadable.execution_outcome, None);
    assert!(matches!(unreadable.outcome, DecodeOutcome::Failed { .. }));
}

#[test]
fn refuses_to_attribute_an_outcome_to_a_different_registry_identity_or_slot() {
    let (mut raw, payload) = fixture("legacy-sol-transfer");
    raw.signature = Signature::from_bytes([1; 64]);
    let wrong_signature = decode(&raw, &payload, Timestamp::UNIX_EPOCH);
    assert_eq!(wrong_signature.execution_outcome, None);
    assert!(matches!(
        wrong_signature.outcome,
        DecodeOutcome::Failed { .. }
    ));
    let (mut raw, payload) = fixture("legacy-sol-transfer");
    raw.slot += 1;
    let wrong_slot = decode(&raw, &payload, Timestamp::UNIX_EPOCH);
    assert_eq!(wrong_slot.execution_outcome, None);
    assert!(matches!(wrong_slot.outcome, DecodeOutcome::Failed { .. }));
}

#[test]
fn does_not_treat_an_unknown_program_instruction_without_events_as_not_applicable() {
    let (_, payload) = fixture("legacy-sol-transfer");
    let mut transaction = read(&payload).unwrap();
    let instruction = transaction.instructions.first_mut().unwrap();
    instruction.program = binsight_dlmm::program::PROGRAM_ID;
    instruction.data = binsight_solana::transaction::InstructionData(vec![0]);
    assert_eq!(
        decode_activity(&transaction).unwrap(),
        DecodeOutcome::Decoded(Vec::new())
    );
    let activity = binsight_dlmm::position_activity(&transaction, &[]).unwrap();
    assert!(activity.has_unknown_program_activity);
}
