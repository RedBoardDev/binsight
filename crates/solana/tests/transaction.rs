//! Reading real mainnet transactions, one fixture per format or rule.

mod common;

use binsight_core::units::{Lamports, RawTokenAmount};
use binsight_solana::programs::TokenProgram;
use binsight_solana::transaction::{
    AccountSource, FeeBreakdown, TransactionReadError, TxOutcome, TxVersion, read,
};

#[test]
fn reads_a_legacy_transaction_with_its_signers_and_fee_payer() {
    let case = common::case("legacy-sol-transfer");
    let view = read(&case.transaction_json(0)).unwrap();
    assert_eq!(view.version, TxVersion::Legacy);
    assert_eq!(view.signature.to_string(), case.transactions[0].signature);
    assert_eq!(view.slot, case.transactions[0].slot);
    assert_eq!(view.fee_payer.to_string(), case.perspective.unwrap());
    let signers: Vec<bool> = view.accounts.iter().map(|key| key.is_signer).collect();
    let writable: Vec<bool> = view.accounts.iter().map(|key| key.is_writable).collect();
    assert_eq!(signers, [true, false, false]);
    assert_eq!(writable, [true, true, false]);
    assert_eq!(view.outcome, TxOutcome::Succeeded);
    assert_eq!(view.native_balances[1].pre, Lamports(0));
    assert_eq!(view.native_balances[1].post, Lamports(9_321_520));
    assert_eq!(
        view.block_time.map(jiff::Timestamp::as_second),
        Some(1_791_115_474)
    );
}

#[test]
fn resolves_lookup_table_accounts_after_the_static_keys() {
    let view = read(&common::case("v0-add-liquidity-alt").transaction_json(0)).unwrap();
    assert_eq!(view.version, TxVersion::V0);
    let first_loaded = view
        .accounts
        .iter()
        .position(|key| matches!(key.source, AccountSource::LookupTable { .. }))
        .unwrap();
    assert!(
        view.accounts[..first_loaded]
            .iter()
            .all(|key| key.source == AccountSource::Message)
    );
    let loaded = &view.accounts[first_loaded..];
    assert_eq!(loaded.len(), 7);
    assert_eq!(
        loaded[0].address,
        common::address("9GGQjMqqkjPTVsyPrfrVEycGr95j4rbjdtPgHBX5vzPP")
    );
    assert!(loaded[0].is_writable);
    assert_eq!(
        loaded[6].address,
        common::address("LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo")
    );
    assert!(
        loaded[1..]
            .iter()
            .all(|key| !key.is_writable && !key.is_signer)
    );
    assert_eq!(view.native_balances.len(), view.accounts.len());
}

#[test]
fn reads_a_version_1_transaction_and_its_priority_fee_from_the_header() {
    let case = common::case("v1-rebalance-liquidity");
    let view = read(&case.transaction_json(0)).unwrap();
    assert_eq!(view.version, TxVersion::V1);
    assert_eq!(view.signature.to_string(), case.transactions[0].signature);
    assert_eq!(view.fee_payer.to_string(), case.perspective.unwrap());
    assert_eq!(
        view.fee,
        FeeBreakdown {
            total: Lamports(6_000),
            base: Lamports(5_000),
            priority: Lamports(1_000),
        }
    );
    assert!(
        view.accounts
            .iter()
            .all(|key| key.source == AccountSource::Message)
    );
}

#[test]
fn keeps_a_failed_transaction_with_its_fee_and_error() {
    let view = read(&common::case("failed-swap-through-dlmm").transaction_json(0)).unwrap();
    assert_eq!(
        view.outcome,
        TxOutcome::Failed {
            error: r#"{"InstructionError":[1,{"Custom":202}]}"#.to_owned()
        }
    );
    assert_eq!(view.fee.total, Lamports(5_180));
    assert_eq!(view.fee.priority, Lamports(180));
    let payer = &view.native_balances[0];
    assert_eq!(payer.pre.try_sub(payer.post), Ok(view.fee.total));
    assert!(
        view.instructions
            .iter()
            .any(|node| node.position.inner.is_some())
    );
}

#[test]
fn reads_a_token_2022_transfer_whose_fee_is_withheld() {
    let view = read(&common::case("token2022-transfer-fee").transaction_json(0)).unwrap();
    let fee_token = common::address("DEW9dSN6QpWyNthphCpMmAbZP1Q4cEKR9xQXAri98WDP");
    let moves: Vec<(u128, u128)> = view
        .token_balances
        .iter()
        .filter(|balance| balance.mint == fee_token)
        .map(|balance| (balance.pre.0, balance.post.0))
        .collect();
    assert_eq!(
        moves,
        [
            (107_651_560_026, 107_685_069_614),
            (4_383_607_916_533, 4_383_574_068_464)
        ]
    );
    let received = 107_685_069_614_u128 - 107_651_560_026;
    let sent = 4_383_607_916_533_u128 - 4_383_574_068_464;
    assert_eq!(sent - received, 338_481);
    assert!(
        view.token_balances
            .iter()
            .filter(|balance| balance.mint == fee_token)
            .all(|balance| balance.program == TokenProgram::Token2022)
    );
}

#[test]
fn refuses_a_version_it_does_not_know() {
    let json = common::case("v1-rebalance-liquidity").transaction_json(0);
    let mut answer: serde_json::Value = serde_json::from_slice(&json).unwrap();
    let encoded = answer["transaction"][0].as_str().unwrap().to_owned();
    let mut bytes = common::base64_decode(&encoded);
    bytes[0] = 0x82;
    answer["transaction"][0] = common::base64_encode(&bytes).into();
    let error = read(answer.to_string().as_bytes()).unwrap_err();
    assert!(matches!(
        error,
        TransactionReadError::UnsupportedVersion(version) if version.number == 2
    ));
}

#[test]
fn refuses_an_answer_whose_version_disagrees_with_the_bytes() {
    let json = common::case("legacy-sol-transfer").transaction_json(0);
    let mut answer: serde_json::Value = serde_json::from_slice(&json).unwrap();
    answer["version"] = 0.into();
    assert!(matches!(
        read(answer.to_string().as_bytes()),
        Err(TransactionReadError::VersionMismatch {
            declared: TxVersion::V0,
            read: TxVersion::Legacy
        })
    ));
}

#[test]
fn reads_raw_token_amounts_beyond_2_pow_53_without_loss() {
    let json = common::case("token2022-transfer-fee").transaction_json(0);
    let mut answer: serde_json::Value = serde_json::from_slice(&json).unwrap();
    let amount = &mut answer["meta"]["postTokenBalances"][0]["uiTokenAmount"];
    amount["amount"] = "900719925474099312345".into();
    let view = read(answer.to_string().as_bytes()).unwrap();
    assert_eq!(
        view.token_balances[0].post,
        RawTokenAmount(900_719_925_474_099_312_345)
    );
}

#[test]
fn ignores_the_floating_point_ui_amount_entirely() {
    let json = common::case("token2022-transfer-fee").transaction_json(0);
    let mut answer: serde_json::Value = serde_json::from_slice(&json).unwrap();
    for side in ["preTokenBalances", "postTokenBalances"] {
        for balance in answer["meta"][side].as_array_mut().unwrap() {
            balance["uiTokenAmount"]["uiAmount"] = "not a number".into();
        }
    }
    let original = read(&json).unwrap();
    assert_eq!(read(answer.to_string().as_bytes()).unwrap(), original);
    let response_shape = include_str!("../src/transaction/rpc_response.rs");
    assert!(!response_shape.contains("f64") && !response_shape.contains("f32"));
}

#[test]
fn reports_a_token_account_created_inside_the_transaction_with_a_zero_pre_balance() {
    let json = common::case("token2022-transfer-fee").transaction_json(0);
    let mut answer: serde_json::Value = serde_json::from_slice(&json).unwrap();
    answer["meta"]["preTokenBalances"]
        .as_array_mut()
        .unwrap()
        .remove(0);
    let view = read(answer.to_string().as_bytes()).unwrap();
    let created = &view.token_balances[0];
    assert_eq!(created.pre, RawTokenAmount::ZERO);
    assert_eq!(created.owner_pre, None);
    assert_eq!(created.post, RawTokenAmount(107_685_069_614));
    assert!(created.owner_post.is_some());
}

#[test]
fn keeps_both_owners_when_a_token_account_changes_owner() {
    let json = common::case("token2022-transfer-fee").transaction_json(0);
    let mut answer: serde_json::Value = serde_json::from_slice(&json).unwrap();
    let new_owner = "11111111111111111111111111111112";
    answer["meta"]["postTokenBalances"][0]["owner"] = new_owner.into();
    let view = read(answer.to_string().as_bytes()).unwrap();
    let balance = &view.token_balances[0];
    assert_eq!(
        balance.owner_pre,
        Some(common::address(
            "GymS3jpXvCLPSnMQrdFDJYqoU7SiLUH3D625i1QzZfJY"
        ))
    );
    assert_eq!(balance.owner_post, Some(common::address(new_owner)));
}
