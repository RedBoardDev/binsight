//! The balance check against a scripted provider and a real database: each decision it takes,
//! and the gap it fills.

use std::sync::Arc;
use std::time::Duration;

use binsight_chain::test_support::{ScriptedReply, ScriptedTransport};
use binsight_core::units::RawTokenAmount;
use binsight_dlmm::{DECODER_NAME, DECODER_VERSION};
use binsight_solana::transaction::READER_VERSION;
use binsight_store::{DecodeOutcome, DecodeRecord, Store, WalletProgress};
use serde_json::json;

use super::*;
use crate::ingestion::WalletStatus;
use crate::test_support::{
    RunningEngine, TEST_START, complete_history, expect_nothing_new, expect_transactions,
    numbered_signature, signature_page,
};

const WALLET: Address = Address::from_bytes([1; 32]);
const ACCOUNT: Address = Address::from_bytes([7; 32]);
const TOKEN_PROGRAM: &str = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

/// The slot of the signature numbered `number` in `signature_page`.
fn slot_of(number: u16) -> u64 {
    100_000 - u64::from(number)
}

/// What the registry's transaction numbered `number` left in [`ACCOUNT`]: `amount`.
fn known(number: u16, amount: u128) -> TokenAccountBalance {
    TokenAccountBalance {
        wallet: WALLET,
        token_account: ACCOUNT,
        mint: Address::from_bytes([8; 32]),
        signature: numbered_signature(number),
        slot: slot_of(number),
        transaction_index: Some(0),
        amount: RawTokenAmount(amount),
        is_owned: true,
    }
}

/// Records, as the decoder would, that the stored transaction numbered `number` left `amount`
/// in [`ACCOUNT`].
async fn record_balance(store: &Store, number: u16, amount: u128) {
    let verdict = DecodeRecord {
        signature: numbered_signature(number),
        decoder: DECODER_NAME.to_owned(),
        decoder_version: DECODER_VERSION,
        reader_version: READER_VERSION,
        execution_outcome: None,
        transaction_index: Some(0),
        outcome: DecodeOutcome::NotApplicable,
        decoded_at: TEST_START,
    };
    store
        .decoded()
        .record_with_balances(verdict, vec![known(number, amount)])
        .await
        .unwrap();
}

/// Expects a read of [`ACCOUNT`] answered with `amount`, read at a slot after every listed one.
fn expect_read(transport: &ScriptedTransport, amount: u64) {
    transport
        .expect("getMultipleAccounts")
        .with_params(json!([
            [ACCOUNT.to_string()],
            {"encoding": "base64", "commitment": "finalized",
             "dataSlice": {"offset": 64, "length": 8}}
        ]))
        .respond(ScriptedReply::Result(json!({
            "context": {"slot": 200_000},
            "value": [{"data": [encoded(amount), "base64"], "lamports": 2_039_280,
                       "owner": TOKEN_PROGRAM, "executable": false}]
        })));
}

/// The base64 text the node writes for `amount` as eight little-endian bytes.
fn encoded(amount: u64) -> &'static str {
    match amount {
        50 => "MgAAAAAAAAA=",
        80 => "UAAAAAAAAAA=",
        other => panic!("no encoding written down for {other}"),
    }
}

/// Expects a listing of [`ACCOUNT`] down to the transaction numbered `until`, answered with
/// `page`.
fn expect_account_listing(transport: &ScriptedTransport, until: u16, page: ScriptedReply) {
    transport
        .expect("getSignaturesForAddress")
        .with_params(json!([
            ACCOUNT.to_string(),
            {"limit": 1_000, "commitment": "finalized",
             "until": numbered_signature(until).to_string()}
        ]))
        .respond(page);
}

/// Ingestion on `setup`, its wallet published as `state`.
fn ingestion_with(setup: &crate::test_support::TemporaryEngine, state: SyncState) -> Ingestion {
    let ingestion = Ingestion::on_test_engine(setup);
    let status = WalletStatus {
        progress: WalletProgress {
            wallet: binsight_store::TrackedWallet {
                address: WALLET,
                added_at: TEST_START,
                cursor: binsight_store::WalletCursor::NotStarted,
            },
            backlog: binsight_store::WalletBacklog::default(),
            listing: binsight_store::WalletListing::default(),
        },
        state,
    };
    ingestion
        .sync
        .statuses
        .send_replace(Some(Arc::new(vec![status])));
    ingestion
}

fn calls_of(transport: &ScriptedTransport, method: &str) -> usize {
    transport
        .calls()
        .iter()
        .filter(|call| call.method == method)
        .count()
}

#[tokio::test(start_paused = true)]
async fn lists_the_token_account_whose_balance_disagrees_with_the_registry() {
    let setup = complete_history(&[WALLET], 2_000).await;
    record_balance(&setup.store, 2_000, 50).await;
    expect_nothing_new(&setup.transport, WALLET, 2_000);
    expect_read(&setup.transport, 80);
    expect_read(&setup.transport, 80);
    expect_account_listing(&setup.transport, 2_000, signature_page(1_500, 1));
    expect_transactions(&setup.transport, 1);
    let engine = RunningEngine::start(setup);

    let counts = engine
        .wait_for_counts(WALLET, |counts| counts.fetched == 2)
        .await;

    assert_eq!(counts.listed, 2);
    let listed = engine.transport.calls();
    let read_at = listed
        .iter()
        .position(|call| call.method == "getMultipleAccounts")
        .unwrap();
    assert!(read_at > 0, "the stream and the top-up come first");
    engine.stop().await;
}

#[tokio::test(start_paused = true)]
async fn reads_the_accounts_once_and_lists_nothing_when_every_balance_agrees() {
    let setup = complete_history(&[WALLET], 2_000).await;
    record_balance(&setup.store, 2_000, 50).await;
    let ingestion = ingestion_with(&setup, SyncState::Live);
    expect_read(&setup.transport, 50);
    let mut unexplained = HashSet::new();

    check_once(&ingestion, &mut unexplained, &CancellationToken::new())
        .await
        .unwrap();

    assert_eq!(setup.transport.calls().len(), 1);
    setup.transport.assert_no_unexpected_calls();
}

#[tokio::test(start_paused = true)]
async fn lists_a_disagreement_a_listing_could_not_explain_only_once() {
    let setup = complete_history(&[WALLET], 2_000).await;
    record_balance(&setup.store, 2_000, 50).await;
    let ingestion = ingestion_with(&setup, SyncState::Live);
    for _suspect_and_confirmation_twice in 0..4 {
        expect_read(&setup.transport, 80);
    }
    expect_account_listing(&setup.transport, 2_000, ScriptedReply::Result(json!([])));
    let mut unexplained = HashSet::new();
    let shutdown = CancellationToken::new();

    check_once(&ingestion, &mut unexplained, &shutdown)
        .await
        .unwrap();
    check_once(&ingestion, &mut unexplained, &shutdown)
        .await
        .unwrap();

    assert_eq!(calls_of(&setup.transport, "getSignaturesForAddress"), 1);
    assert_eq!(calls_of(&setup.transport, "getMultipleAccounts"), 4);
    setup.transport.assert_no_unexpected_calls();
}

#[tokio::test(start_paused = true)]
async fn leaves_a_disagreement_the_registry_explains_while_it_waits() {
    let setup = complete_history(&[WALLET], 2_000).await;
    record_balance(&setup.store, 2_000, 50).await;
    let stored_later = binsight_store::FetchedTx {
        signature: numbered_signature(1_900),
        slot: slot_of(1_900),
        block_time: Some(TEST_START),
        tx_version: binsight_solana::transaction::TxVersion::V0,
        commitment: binsight_solana::Commitment::Finalized,
        encoding: binsight_solana::transaction::TxEncoding::Base64,
        payload: b"{}".to_vec(),
        fetched_at: TEST_START,
    };
    setup
        .store
        .fetch_queue()
        .complete(stored_later)
        .await
        .unwrap();
    let ingestion = ingestion_with(&setup, SyncState::Live);
    expect_read(&setup.transport, 80);
    let mut unexplained = HashSet::new();
    let shutdown = CancellationToken::new();
    let decoder_catches_up = async {
        tokio::time::sleep(Duration::from_secs(30)).await;
        record_balance(&setup.store, 1_900, 80).await;
    };

    let (checked, ()) = tokio::join!(
        check_once(&ingestion, &mut unexplained, &shutdown),
        decoder_catches_up
    );

    checked.unwrap();
    assert_eq!(setup.transport.calls().len(), 1);
    setup.transport.assert_no_unexpected_calls();
}

#[tokio::test(start_paused = true)]
async fn compares_nothing_for_a_wallet_still_importing() {
    let setup = complete_history(&[WALLET], 2_000).await;
    record_balance(&setup.store, 2_000, 50).await;
    let ingestion = ingestion_with(&setup, SyncState::Importing);
    let mut unexplained = HashSet::new();

    check_once(&ingestion, &mut unexplained, &CancellationToken::new())
        .await
        .unwrap();

    assert_eq!(setup.transport.calls(), Vec::new());
}
