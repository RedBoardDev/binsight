//! Known protocol classifications take precedence over inferred exchanges.
#[path = "common/book.rs"]
mod common;
use binsight_dlmm::activity::TxActivity;
use binsight_ledger::book::{Asset, Counterparty, EntryKind, WalletContext, book_transaction};
use binsight_ledger::counterparties::BridgeId;
use binsight_solana::Address;
use common::*;

/// Mayan's Swift program.
const MAYAN_SWIFT: &str = "BLZRi6frs4X4DNLw56V4EXai1b6QVESN1BhHBTYM9VcY";

fn protocol_transaction() -> binsight_solana::transaction::TransactionView {
    protocol_transaction_of(address(42))
}

fn protocol_transaction_of(program: Address) -> binsight_solana::transaction::TransactionView {
    let mut tx = transaction(200_000, 95_000);
    tx.instructions.push(instruction(program, vec![], vec![]));
    tx.token_balances
        .push(token(address(3), address(1), address(9), 0, 50));
    tx.native_balances.push(native(address(3), 200, 200));
    tx
}

#[test]
fn a_known_bridge_books_both_assets_as_capital_instead_of_a_swap() {
    let tx = protocol_transaction_of(MAYAN_SWIFT.parse().unwrap());
    let wallet = WalletContext::new(address(1));
    let entries = book_transaction(&wallet, &tx, &TxActivity::default()).unwrap();
    assert!(entries.iter().any(|entry| entry.asset == Asset::Sol
        && entry.amount == -100_000
        && entry.kind
            == EntryKind::CapitalWithdrawal {
                counterparty: Counterparty::Bridge(BridgeId::Mayan)
            }));
    assert!(
        entries
            .iter()
            .any(|entry| entry.asset == Asset::Token { mint: address(9) }
                && entry.amount == 50
                && entry.kind
                    == EntryKind::CapitalDeposit {
                        counterparty: Counterparty::Bridge(BridgeId::Mayan)
                    })
    );
    assert!(
        entries
            .iter()
            .all(|entry| !matches!(entry.kind, EntryKind::SwapIn | EntryKind::SwapOut))
    );
}

#[test]
fn a_known_service_payment_and_an_unrelated_receipt_do_not_form_a_swap() {
    let tx = protocol_transaction();
    let mut wallet = WalletContext::new(address(1));
    wallet.services.insert(address(42));
    let entries = book_transaction(&wallet, &tx, &TxActivity::default()).unwrap();
    assert!(entries.iter().any(|entry| entry.asset == Asset::Sol
        && entry.amount == -100_000
        && entry.kind
            == EntryKind::ServiceFee {
                program: address(42)
            }));
    assert!(entries.iter().any(|entry| entry.amount == 50
        && entry.kind
            == EntryKind::ProtocolActivity {
                program: address(42)
            }));
    assert!(
        entries
            .iter()
            .all(|entry| !matches!(entry.kind, EntryKind::SwapIn | EntryKind::SwapOut))
    );
}

#[test]
fn someone_elses_token_account_rent_subsidy_creates_no_wallet_sol_or_wrap() {
    let mut tx = transaction(100_000, 95_000);
    let mut balance = token(address(3), address(1), address(9), 0, 0);
    balance.owner_pre = None;
    tx.token_balances.push(balance);
    tx.native_balances.push(native(address(3), 0, 200));
    tx.instructions.push(transfer(address(2), address(3), 200));
    let entries =
        book_transaction(&WalletContext::new(address(1)), &tx, &TxActivity::default()).unwrap();
    assert_eq!(entries.len(), 2);
    assert!(entries.iter().any(|entry| entry.asset == Asset::Rent
        && entry.amount == 200
        && entry.kind
            == EntryKind::CapitalDeposit {
                counterparty: Counterparty::External {
                    address: Some(address(2))
                }
            }));
    assert_eq!(
        entries
            .iter()
            .filter(|entry| entry.asset == Asset::Sol)
            .map(|entry| entry.amount)
            .sum::<i128>(),
        -5_000
    );
}

fn delegated_loss() -> binsight_solana::transaction::TransactionView {
    let mut tx = transaction(100_000, 100_000);
    tx.fee_payer = address(4);
    tx.accounts.clear();
    tx.accounts.push(binsight_solana::transaction::AccountKey {
        address: address(4),
        is_signer: true,
        is_writable: true,
        source: binsight_solana::transaction::AccountSource::Message,
    });
    tx.token_balances
        .push(token(address(2), address(1), address(9), 100, 0));
    tx.native_balances.push(native(address(2), 200, 200));
    tx
}

#[test]
fn an_unsigned_token_2022_authority_reclaim_is_a_loss_instead_of_capital() {
    let mut tx = delegated_loss();
    tx.token_balances[0].program = binsight_solana::programs::TokenProgram::Token2022;
    tx.instructions.push(instruction(
        binsight_solana::well_known::TOKEN_2022_PROGRAM,
        vec![address(2), address(3), address(4)],
        {
            let mut bytes = vec![3];
            bytes.extend(100_u64.to_le_bytes());
            bytes
        },
    ));
    let entries =
        book_transaction(&WalletContext::new(address(1)), &tx, &TxActivity::default()).unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].amount, -100);
    assert_eq!(
        entries[0].kind,
        EntryKind::ProtocolActivity {
            program: binsight_solana::well_known::TOKEN_2022_PROGRAM
        }
    );
}

#[test]
fn an_unsigned_delegated_token_transfer_is_not_an_owner_capital_withdrawal() {
    let mut tx = delegated_loss();
    tx.token_balances
        .push(token(address(3), address(5), address(9), 0, 100));
    let mut bytes = vec![3];
    bytes.extend(100_u64.to_le_bytes());
    tx.instructions.push(instruction(
        binsight_solana::well_known::TOKEN_PROGRAM,
        vec![address(2), address(3), address(4)],
        bytes,
    ));
    let entries =
        book_transaction(&WalletContext::new(address(1)), &tx, &TxActivity::default()).unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].amount, -100);
    assert_eq!(
        entries[0].kind,
        EntryKind::ProtocolActivity {
            program: binsight_solana::well_known::TOKEN_PROGRAM
        }
    );
}

#[test]
fn a_delegated_burn_of_owned_tokens_remains_a_burn() {
    let mut tx = delegated_loss();
    let mut bytes = vec![8];
    bytes.extend(100_u64.to_le_bytes());
    tx.instructions.push(instruction(
        binsight_solana::well_known::TOKEN_PROGRAM,
        vec![address(2), address(9), address(4)],
        bytes,
    ));
    let entries =
        book_transaction(&WalletContext::new(address(1)), &tx, &TxActivity::default()).unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].amount, -100);
    assert_eq!(entries[0].kind, EntryKind::Burn);
}

/// A protocol transaction of wallet 1 pays it 50 tokens and sends 1 SOL to wallet 4, which this
/// instance also tracks: the SOL is capital moved between the two wallets on both sides, and only
/// the tokens are the protocol's.
#[test]
fn books_a_transfer_to_a_tracked_wallet_inside_a_protocol_transaction_as_capital() {
    let (a, b) = (address(1), address(4));
    let mut tx = transaction(2_000_000_000, 999_995_000);
    tx.native_balances.push(native(b, 0, 1_000_000_000));
    tx.instructions
        .push(instruction(address(42), vec![], vec![]));
    tx.instructions.push(transfer(a, b, 1_000_000_000));
    tx.token_balances
        .push(token(address(3), a, address(9), 0, 50));
    tx.native_balances.push(native(address(3), 200, 200));
    let mut wallet_a = WalletContext::new(a);
    wallet_a.tracked_wallets.insert(b);
    let mut wallet_b = WalletContext::new(b);
    wallet_b.tracked_wallets.insert(a);
    let of = |wallet: &WalletContext| {
        book_transaction(wallet, &tx, &TxActivity::default())
            .unwrap()
            .into_iter()
            .map(|entry| (entry.asset, entry.amount, entry.kind))
            .collect::<Vec<_>>()
    };
    assert_eq!(
        of(&wallet_a),
        [
            (Asset::Sol, -5_000, EntryKind::NetworkFee),
            (
                Asset::Sol,
                -1_000_000_000,
                EntryKind::CapitalWithdrawal {
                    counterparty: Counterparty::TrackedWallet(b)
                }
            ),
            (
                Asset::Token { mint: address(9) },
                50,
                EntryKind::ProtocolActivity {
                    program: address(42)
                }
            ),
        ]
    );
    assert_eq!(
        of(&wallet_b),
        [(
            Asset::Sol,
            1_000_000_000,
            EntryKind::CapitalDeposit {
                counterparty: Counterparty::TrackedWallet(a)
            }
        )]
    );
}

/// A `TransferCheckedWithFee` of `amount` with `fee` withheld, as an inner instruction.
fn taxed_transfer(
    (source, mint, destination): (Address, Address, Address),
    amount: u64,
    fee: u64,
    inner: u16,
) -> binsight_solana::transaction::InstructionNode {
    let mut data = vec![26, 1];
    data.extend(amount.to_le_bytes());
    data.push(6);
    data.extend(fee.to_le_bytes());
    let mut node = instruction(
        binsight_solana::well_known::TOKEN_2022_PROGRAM,
        vec![source, mint, destination, source],
        data,
    );
    node.position.inner = Some(inner);
    node.stack_height = Some(2);
    node
}

/// Wallet 4, also tracked, sends 100 taxed tokens to wallet 1's account, whose transfer hook
/// calls another program. Only native programs run at top level, so the transaction is direct:
/// the receipt is booked once, as capital from wallet 4, with its tax of 2.
#[test]
fn books_a_hooked_transfer_from_a_tracked_wallet_once() {
    let (a, b, mint) = (address(1), address(4), address(9));
    let mut tx = transaction(100_000, 95_000);
    let mut source = token(address(5), b, mint, 100, 0);
    let mut destination = token(address(3), a, mint, 0, 98);
    source.program = binsight_solana::programs::TokenProgram::Token2022;
    destination.program = binsight_solana::programs::TokenProgram::Token2022;
    tx.token_balances.extend([source, destination]);
    tx.native_balances.push(native(address(3), 200, 200));
    tx.instructions.push(instruction(
        binsight_solana::well_known::MEMO_PROGRAM,
        vec![],
        b"gift".to_vec(),
    ));
    tx.instructions
        .push(taxed_transfer((address(5), mint, address(3)), 100, 2, 0));
    let mut hook = instruction(address(42), vec![], vec![]);
    hook.position.inner = Some(1);
    hook.stack_height = Some(2);
    tx.instructions.push(hook);
    let mut wallet = WalletContext::new(a);
    wallet.tracked_wallets.insert(b);
    let entries: Vec<_> = book_transaction(&wallet, &tx, &TxActivity::default())
        .unwrap()
        .into_iter()
        .map(|entry| (entry.asset, entry.amount, entry.kind))
        .collect();
    assert_eq!(
        entries,
        [
            (Asset::Sol, -5_000, EntryKind::NetworkFee),
            (
                Asset::Token { mint },
                100,
                EntryKind::CapitalDeposit {
                    counterparty: Counterparty::TrackedWallet(b)
                }
            ),
            (Asset::Token { mint }, -2, EntryKind::TransferFee),
        ]
    );
}

/// In a protocol transaction, wallet 1's account receives 100 taxed tokens (tax 2) from tracked
/// wallet 4 and 50 (tax 1) from the protocol. Only the tracked receipt's tax is booked with it;
/// the protocol's 49 net tokens stay the protocol's.
#[test]
fn books_only_the_tax_of_a_tracked_receipt_in_a_protocol_transaction() {
    let (a, b, mint) = (address(1), address(4), address(9));
    let mut tx = transaction(100_000, 95_000);
    let mut balances = [
        token(address(5), b, mint, 100, 0),
        token(address(6), address(25), mint, 50, 0),
        token(address(3), a, mint, 0, 147),
    ];
    for balance in &mut balances {
        balance.program = binsight_solana::programs::TokenProgram::Token2022;
    }
    tx.token_balances.extend(balances);
    tx.native_balances.push(native(address(3), 200, 200));
    tx.instructions
        .push(instruction(address(42), vec![], vec![]));
    tx.instructions
        .push(taxed_transfer((address(5), mint, address(3)), 100, 2, 0));
    tx.instructions
        .push(taxed_transfer((address(6), mint, address(3)), 50, 1, 1));
    let mut wallet = WalletContext::new(a);
    wallet.tracked_wallets.insert(b);
    let entries: Vec<_> = book_transaction(&wallet, &tx, &TxActivity::default())
        .unwrap()
        .into_iter()
        .map(|entry| (entry.asset, entry.amount, entry.kind))
        .collect();
    assert_eq!(
        entries,
        [
            (Asset::Sol, -5_000, EntryKind::NetworkFee),
            (
                Asset::Token { mint },
                100,
                EntryKind::CapitalDeposit {
                    counterparty: Counterparty::TrackedWallet(b)
                }
            ),
            (Asset::Token { mint }, -2, EntryKind::TransferFee),
            (
                Asset::Token { mint },
                49,
                EntryKind::ProtocolActivity {
                    program: address(42)
                }
            ),
        ]
    );
}
