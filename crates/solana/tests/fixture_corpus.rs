//! Properties every mainnet fixture must have, and a readable snapshot of each one.
//!
//! The snapshots are the reviewable form of the fixtures: a change in how a transaction is read
//! shows up as a diff of its snapshot.

mod common;

use binsight_core::units::Lamports;
use binsight_solana::programs;
use binsight_solana::transaction::{LAMPORTS_PER_SIGNATURE, TxOutcome, read};

#[test]
fn reads_every_fixture_with_its_signature_and_slot() {
    for case in common::all_cases() {
        for (position, expected) in case.transactions.iter().enumerate() {
            let view = read(&case.transaction_json(position))
                .unwrap_or_else(|error| panic!("{}: {error:?}", case.name));
            assert_eq!(
                view.signature.to_string(),
                expected.signature,
                "{}",
                case.name
            );
            assert_eq!(view.slot, expected.slot, "{}", case.name);
        }
    }
}

#[test]
fn the_base_fee_is_5000_lamports_per_signature_on_every_fixture() {
    for case in common::all_cases() {
        let view = read(&case.transaction_json(0)).unwrap();
        let signers = view.accounts.iter().filter(|key| key.is_signer).count();
        let expected = LAMPORTS_PER_SIGNATURE.0 * u64::try_from(signers).unwrap();
        assert_eq!(view.fee.base, Lamports(expected), "{}", case.name);
        assert_eq!(
            view.fee.base.try_add(view.fee.priority),
            Ok(view.fee.total),
            "{}",
            case.name
        );
    }
}

#[test]
fn splits_the_fee_into_base_and_priority() {
    let view = read(&common::case("v0-add-liquidity-alt").transaction_json(0)).unwrap();
    assert_eq!(view.fee.total, Lamports(10_297));
    assert_eq!(view.fee.base, Lamports(10_000));
    assert_eq!(view.fee.priority, Lamports(297));
}

#[test]
fn decodes_every_known_instruction_of_every_successful_fixture() {
    for case in common::all_cases() {
        let view = read(&case.transaction_json(0)).unwrap();
        if view.outcome != TxOutcome::Succeeded {
            continue;
        }
        for instruction in &view.instructions {
            programs::decode(instruction).unwrap_or_else(|error| {
                panic!("{} {:?}: {error}", case.name, instruction.position)
            });
        }
    }
}

#[test]
fn every_fixture_reads_as_its_snapshot() {
    for case in common::all_cases() {
        let view = read(&case.transaction_json(0)).unwrap();
        insta::assert_debug_snapshot!(case.name.clone(), view);
    }
}
