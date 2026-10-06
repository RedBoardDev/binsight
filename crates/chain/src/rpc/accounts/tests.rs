//! Reading accounts against a scripted provider.

use std::sync::Arc;

use binsight_core::clock::FixedClock;
use binsight_core::credits::{Priority, Purpose};
use jiff::Timestamp;
use serde_json::json;

use super::*;
use crate::test_support::{ScriptedReply, ScriptedTransport, scripted_client};

fn context() -> CallContext {
    CallContext {
        priority: Priority::History,
        purpose: Purpose::BalanceCheck,
        wallet: None,
    }
}

#[test]
fn refuses_an_empty_batch_and_one_too_large_for_a_request() {
    let too_many = vec![Address::from_bytes([1; 32]); ACCOUNT_BATCH_LIMIT + 1];

    assert_eq!(AccountBatch::new(Vec::new()), Err(AccountBatchError::Empty));
    assert_eq!(
        AccountBatch::new(too_many),
        Err(AccountBatchError::TooLarge(101))
    );
}

#[tokio::test(start_paused = true)]
async fn reads_each_account_in_order_with_the_slice_asked_and_the_missing_ones_as_none() {
    let token_account = Address::from_bytes([4; 32]);
    let closed = Address::from_bytes([5; 32]);
    let owner = Address::from_bytes([6; 32]);
    let transport = ScriptedTransport::new();
    transport
        .expect("getMultipleAccounts")
        .with_params(json!([
            [token_account.to_string(), closed.to_string()],
            {"encoding": "base64", "commitment": "finalized",
             "dataSlice": {"offset": 64, "length": 8}}
        ]))
        .respond(ScriptedReply::Result(json!({
            "context": {"apiVersion": "2.2.0", "slot": 360_000_000},
            "value": [
                {"data": ["QEIPAAAAAAA=", "base64"], "executable": false, "lamports": 2_039_280,
                 "owner": owner.to_string(), "rentEpoch": 0, "space": 165},
                null
            ]
        })));
    let clock = Arc::new(FixedClock::new(Timestamp::UNIX_EPOCH));
    let batch = AccountBatch::new(vec![token_account, closed]).unwrap();
    let slice = DataSlice {
        offset: 64,
        length: 8,
    };

    let read = scripted_client(transport.clone(), clock, None)
        .multiple_accounts(&batch, Some(slice), context())
        .await
        .unwrap();

    assert_eq!(read.slot, 360_000_000);
    assert_eq!(
        read.accounts,
        [
            Some(AccountData {
                lamports: 2_039_280,
                owner,
                data: 1_000_000_u64.to_le_bytes().to_vec(),
            }),
            None
        ]
    );
    transport.assert_no_unexpected_calls();
}

#[test]
fn refuses_an_answer_that_does_not_hold_one_entry_per_account() {
    let answer = r#"{"context":{"slot":1},"value":[null]}"#;

    let read = read_accounts(answer, 2);

    assert!(matches!(read, Err(RpcError::UnexpectedResponse { .. })));
}

#[test]
fn refuses_account_data_in_another_encoding() {
    let owner = Address::from_bytes([6; 32]);
    let answer = format!(
        r#"{{"context":{{"slot":1}},"value":[{{"data":["abc","base58"],"lamports":1,"owner":"{owner}"}}]}}"#
    );

    let read = read_accounts(&answer, 1);

    assert!(matches!(read, Err(RpcError::UnexpectedResponse { .. })));
}
