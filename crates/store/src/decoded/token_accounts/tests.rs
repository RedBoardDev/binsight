//! Recording the token accounts' balances with their decoding, on a real database.

use jiff::Timestamp;

use super::*;
use crate::DecodeOutcome;
use crate::database::test_database::{assert_queries_prepare, migrated_store};
use crate::raw_tx::tests::sample_record;

const WALLET: Address = Address::from_bytes([1; 32]);
const ACCOUNT: Address = Address::from_bytes([2; 32]);

fn verdict(seed: u8) -> DecodeRecord {
    DecodeRecord {
        signature: Signature::from_bytes([seed; 64]),
        decoder: "dlmm".to_owned(),
        decoder_version: 2,
        reader_version: 1,
        execution_outcome: None,
        transaction_index: Some(4),
        outcome: DecodeOutcome::NotApplicable,
        decoded_at: Timestamp::UNIX_EPOCH,
    }
}

fn balance(seed: u8, slot: u64, index: Option<u32>, amount: u128) -> TokenAccountBalance {
    TokenAccountBalance {
        wallet: WALLET,
        token_account: ACCOUNT,
        mint: Address::from_bytes([3; 32]),
        signature: Signature::from_bytes([seed; 64]),
        slot,
        transaction_index: index,
        amount: RawTokenAmount(amount),
        is_owned: true,
    }
}

/// A store tracking [`WALLET`] whose registry holds the transactions made of `seeds`.
async fn store_with(seeds: &[u8]) -> (tempfile::TempDir, Store) {
    let (folder, store) = migrated_store().await;
    store
        .wallets()
        .add(WALLET, Timestamp::UNIX_EPOCH)
        .await
        .unwrap();
    for seed in seeds {
        let raw = sample_record(*seed);
        store.raw_tx().insert_if_absent(raw).await.unwrap();
    }
    (folder, store)
}

#[tokio::test]
async fn prepares_every_query_against_the_schema() {
    assert_queries_prepare(&[UPSERT, SELECT_OWNED]).await;
}

#[tokio::test]
async fn keeps_the_balance_of_the_newest_transaction_whatever_the_order_they_are_read_in() {
    let (_folder, store) = store_with(&[5, 6, 7]).await;
    let decoded = store.decoded();
    let newest = balance(6, 200, Some(3), 1_000);

    decoded
        .record_with_balances(verdict(6), vec![newest])
        .await
        .unwrap();
    decoded
        .record_with_balances(verdict(5), vec![balance(5, 100, Some(9), 50)])
        .await
        .unwrap();
    decoded
        .record_with_balances(verdict(7), vec![balance(7, 200, Some(1), 70)])
        .await
        .unwrap();

    assert_eq!(store.token_accounts().owned().await.unwrap(), [newest]);
    let stored = decoded
        .get(Signature::from_bytes([5; 64]), "dlmm".to_owned())
        .await
        .unwrap();
    assert!(stored.is_some());
}

#[tokio::test]
async fn forgets_an_account_the_wallet_no_longer_owns() {
    let (_folder, store) = store_with(&[5, 6]).await;
    let decoded = store.decoded();
    decoded
        .record_with_balances(verdict(5), vec![balance(5, 100, Some(0), 50)])
        .await
        .unwrap();
    let closed = TokenAccountBalance {
        is_owned: false,
        ..balance(6, 101, Some(0), 0)
    };

    decoded
        .record_with_balances(verdict(6), vec![closed])
        .await
        .unwrap();

    assert_eq!(store.token_accounts().owned().await.unwrap(), []);
}

#[tokio::test]
async fn ignores_the_balance_of_a_wallet_that_is_not_tracked() {
    let (_folder, store) = store_with(&[5]).await;
    let stranger = TokenAccountBalance {
        wallet: Address::from_bytes([9; 32]),
        ..balance(5, 100, None, 50)
    };

    store
        .decoded()
        .record_with_balances(verdict(5), vec![stranger])
        .await
        .unwrap();

    assert_eq!(store.token_accounts().owned().await.unwrap(), []);
}
