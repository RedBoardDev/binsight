//! Mainnet records preserve execution outcomes without inventing successful reads.

use super::*;
use binsight_solana::{Signature, transaction::TxOutcome};
use binsight_store::PayloadCompression;

/// The verdict on `payload`, stored as `raw`, with no wallet tracked.
fn verdict(raw: &RawTxRecord, payload: &[u8]) -> DecodeRecord {
    decode(raw, payload, Timestamp::UNIX_EPOCH, &HashSet::new()).record
}

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
    let record = verdict(&raw, &payload);
    assert!(matches!(
        record.execution_outcome,
        Some(TxOutcome::Failed { .. })
    ));
    assert_eq!(
        record.outcome,
        DecodeOutcome::Decoded,
        "failed execution is not failed decoding"
    );
    let tx = read(&payload).unwrap();
    let activity =
        binsight_dlmm::position_activity(&tx, &binsight_dlmm::decode_events(&tx).unwrap()).unwrap();
    assert_eq!(activity, binsight_dlmm::TxActivity::default());
}

#[test]
fn records_a_successful_dlmm_transaction_as_decoded() {
    let (raw, payload) = fixture("rebalance-with-fees");
    let record = verdict(&raw, &payload);
    assert_eq!(record.execution_outcome, Some(TxOutcome::Succeeded));
    assert_eq!(record.outcome, DecodeOutcome::Decoded);
}

#[test]
fn distinguishes_a_plain_wallet_transfer_from_an_unreadable_execution_result() {
    let (raw, payload) = fixture("legacy-sol-transfer");
    let transfer = verdict(&raw, &payload);
    assert_eq!(transfer.execution_outcome, Some(TxOutcome::Succeeded));
    assert_eq!(transfer.outcome, DecodeOutcome::NotApplicable);
    let mut json: serde_json::Value = serde_json::from_slice(&payload).unwrap();
    json["meta"].as_object_mut().unwrap().remove("err");
    let unreadable = verdict(&raw, &serde_json::to_vec(&json).unwrap());
    assert_eq!(unreadable.execution_outcome, None);
    assert!(matches!(unreadable.outcome, DecodeOutcome::Failed { .. }));
}

#[test]
fn refuses_to_attribute_an_outcome_to_a_different_registry_identity_or_slot() {
    let (mut raw, payload) = fixture("legacy-sol-transfer");
    raw.signature = Signature::from_bytes([1; 64]);
    let wrong_signature = verdict(&raw, &payload);
    assert_eq!(wrong_signature.execution_outcome, None);
    assert!(matches!(
        wrong_signature.outcome,
        DecodeOutcome::Failed { .. }
    ));
    let (mut raw, payload) = fixture("legacy-sol-transfer");
    raw.slot += 1;
    let wrong_slot = verdict(&raw, &payload);
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
        DecodeOutcome::Decoded
    );
    let activity = binsight_dlmm::position_activity(&transaction, &[]).unwrap();
    assert!(activity.has_unknown_program_activity);
}

#[test]
fn records_where_the_transaction_sits_in_its_block() {
    let (raw, payload) = fixture("legacy-sol-transfer");
    let record = verdict(&raw, &payload);
    assert_eq!(record.transaction_index, Some(815));

    let mut json: serde_json::Value = serde_json::from_slice(&payload).unwrap();
    json.as_object_mut().unwrap().remove("transactionIndex");
    let without_index = verdict(&raw, &serde_json::to_vec(&json).unwrap());
    assert_eq!(without_index.transaction_index, None);
    assert_eq!(without_index.outcome, DecodeOutcome::NotApplicable);
}
