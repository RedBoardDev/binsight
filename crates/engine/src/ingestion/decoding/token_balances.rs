//! What a transaction left in the token accounts the tracked wallets own, as a pure rule.
//!
//! A token balance of a transaction names its account's owner before and after it. For every
//! tracked wallet among those owners, the balance after the transaction is kept, with whether the
//! wallet still owns the account (it does not once the account is closed or handed over). A
//! balance whose owners the node did not report is left out: it cannot be attributed. The rows
//! feed the daily comparison of the accounts with the chain; this module does no I/O.

use std::collections::HashSet;

use binsight_solana::Address;
use binsight_solana::transaction::{TokenBalance, TransactionView};
use binsight_store::TokenAccountBalance;

/// What `transaction` left in each token account one of `wallets` owned before or after it.
pub(super) fn tracked_token_balances(
    transaction: &TransactionView,
    wallets: &HashSet<Address>,
) -> Vec<TokenAccountBalance> {
    transaction
        .token_balances
        .iter()
        .flat_map(|balance| {
            owners(balance)
                .filter(|owner| wallets.contains(owner))
                .map(move |wallet| TokenAccountBalance {
                    wallet,
                    token_account: balance.account,
                    mint: balance.mint,
                    signature: transaction.signature,
                    slot: transaction.slot,
                    transaction_index: transaction.transaction_index,
                    amount: balance.post,
                    is_owned: balance.owner_post == Some(wallet),
                })
        })
        .collect()
}

/// The distinct owners of the account before and after.
fn owners(balance: &TokenBalance) -> impl Iterator<Item = Address> {
    let after = balance.owner_post;
    let before = balance.owner_pre.filter(|before| Some(*before) != after);
    after.into_iter().chain(before)
}

#[cfg(test)]
mod tests {
    use binsight_core::units::{Decimals, RawTokenAmount};
    use binsight_solana::Commitment;
    use binsight_solana::programs::TokenProgram;
    use binsight_solana::transaction::{TxEncoding, read};
    use binsight_store::{FetchedTx, RegistryPosition};

    use super::*;
    use crate::ingestion::Ingestion;
    use crate::ingestion::decoding::decode_new;
    use crate::test_support::{TEST_START, temporary_engine};

    const WALLET: Address = Address::from_bytes([1; 32]);
    const OTHER: Address = Address::from_bytes([2; 32]);

    /// The payload of the mainnet fixture `name`.
    fn fixture(name: &str) -> Vec<u8> {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../tests/fixtures/mainnet")
            .join(name)
            .join("tx-1.json");
        std::fs::read(path).unwrap()
    }

    fn transaction(balances: Vec<TokenBalance>) -> TransactionView {
        let mut transaction = read(&fixture("legacy-sol-transfer")).unwrap();
        transaction.token_balances = balances;
        transaction
    }

    fn balance(pre: Option<Address>, post: Option<Address>, amount: u128) -> TokenBalance {
        TokenBalance {
            account: Address::from_bytes([7; 32]),
            mint: Address::from_bytes([8; 32]),
            program: TokenProgram::Token,
            decimals: Decimals(6),
            owner_pre: pre,
            owner_post: post,
            pre: RawTokenAmount(5),
            post: RawTokenAmount(amount),
        }
    }

    fn tracked(wallets: &[Address]) -> HashSet<Address> {
        wallets.iter().copied().collect()
    }

    #[test]
    fn keeps_the_balance_after_the_transaction_of_a_tracked_wallet_account() {
        let view = transaction(vec![
            balance(Some(WALLET), Some(WALLET), 40),
            balance(Some(OTHER), Some(OTHER), 9),
        ]);

        let kept = tracked_token_balances(&view, &tracked(&[WALLET]));

        assert_eq!(kept.len(), 1);
        assert_eq!(kept[0].wallet, WALLET);
        assert_eq!(kept[0].amount, RawTokenAmount(40));
        assert!(kept[0].is_owned);
        assert_eq!(kept[0].signature, view.signature);
        assert_eq!(kept[0].transaction_index, view.transaction_index);
    }

    #[test]
    fn marks_an_account_closed_or_handed_over_as_no_longer_owned() {
        let view = transaction(vec![balance(Some(WALLET), None, 0)]);
        let handed_over = transaction(vec![balance(Some(WALLET), Some(OTHER), 5)]);

        let closed = tracked_token_balances(&view, &tracked(&[WALLET]));
        let both = tracked_token_balances(&handed_over, &tracked(&[WALLET, OTHER]));

        assert!(!closed[0].is_owned);
        let owned: Vec<(Address, bool)> =
            both.iter().map(|row| (row.wallet, row.is_owned)).collect();
        assert_eq!(owned, [(OTHER, true), (WALLET, false)]);
    }

    #[test]
    fn leaves_out_a_balance_whose_owner_the_node_did_not_report() {
        let view = transaction(vec![balance(None, None, 3)]);

        assert_eq!(tracked_token_balances(&view, &tracked(&[WALLET])), []);
    }

    #[tokio::test]
    async fn records_what_a_transaction_left_in_the_tracked_wallets_token_accounts() {
        let setup = temporary_engine().await;
        let payload = fixture("rebalance-with-fees");
        let view = read(&payload).unwrap();
        let raw = FetchedTx {
            signature: view.signature,
            slot: view.slot,
            block_time: view.block_time,
            tx_version: view.version,
            commitment: Commitment::Finalized,
            encoding: TxEncoding::Base64,
            payload,
            fetched_at: TEST_START,
        };
        let payer = view.fee_payer;
        setup.store.wallets().add(payer, TEST_START).await.unwrap();
        setup.store.fetch_queue().complete(raw).await.unwrap();
        let ingestion = Ingestion::on_test_engine(&setup);

        decode_new(&ingestion, &mut RegistryPosition::default())
            .await
            .unwrap();

        let mut owned: Vec<(Address, u128)> = setup
            .store
            .token_accounts()
            .owned()
            .await
            .unwrap()
            .iter()
            .map(|row| (row.token_account, row.amount.0))
            .collect();
        let mut expected: Vec<(Address, u128)> = view
            .token_balances
            .iter()
            .filter(|balance| balance.owner_post == Some(payer))
            .map(|balance| (balance.account, balance.post.0))
            .collect();
        owned.sort();
        expected.sort();
        assert_ne!(expected, Vec::new());
        assert_eq!(owned, expected);
        assert_eq!(setup.transport.calls(), Vec::new());
    }
}
