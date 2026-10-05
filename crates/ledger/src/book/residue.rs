//! Classify remaining changes from direct transfers, known bridges or other protocols.
mod direct;
use super::instructions::{Decoded, native_transfer, token_transfer};
use super::worksheet::Worksheet;
use super::{Asset, BookError, Counterparty, EntryKind, WalletContext};
use binsight_solana::transaction::TransactionView;
use binsight_solana::well_known::{
    ASSOCIATED_TOKEN_PROGRAM, COMPUTE_BUDGET_PROGRAM, ED25519_PROGRAM, LIGHTHOUSE_PROGRAM,
    MEMO_PROGRAM, MEMO_V1_PROGRAM, SECP256K1_PROGRAM, SECP256R1_PROGRAM, SYSTEM_PROGRAM,
    TOKEN_2022_PROGRAM, TOKEN_PROGRAM,
};
use binsight_solana::{
    Address,
    programs::{ProgramInstruction, SystemInstruction, TokenInstruction, TokenProgram},
};

/// A recognised external-chain bridge, recorded as capital rather than protocol PnL.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BridgeId {
    /// Relay cross-chain bridge.
    Relay,
    /// Mayan cross-chain bridge.
    Mayan,
    /// Gas.zip cross-chain funding.
    GasZip,
}

pub(super) fn is_direct(tx: &TransactionView) -> bool {
    tx.instructions
        .iter()
        .all(|node| is_neutral_program(node.program))
}

fn is_neutral_program(program: Address) -> bool {
    [
        SYSTEM_PROGRAM,
        TOKEN_PROGRAM,
        TOKEN_2022_PROGRAM,
        ASSOCIATED_TOKEN_PROGRAM,
        COMPUTE_BUDGET_PROGRAM,
        MEMO_PROGRAM,
        MEMO_V1_PROGRAM,
        LIGHTHOUSE_PROGRAM,
        ED25519_PROGRAM,
        SECP256K1_PROGRAM,
        SECP256R1_PROGRAM,
    ]
    .contains(&program)
}

pub(super) fn book(
    wallet: &WalletContext,
    tx: &TransactionView,
    decoded: &Decoded,
    sheet: &mut Worksheet,
) -> Result<(), BookError> {
    let root = tx
        .instructions
        .iter()
        .find(|node| node.position.inner.is_none() && !is_neutral_program(node.program))
        .map(|node| node.program);
    if root.is_none() {
        direct::book(wallet, tx, decoded, sheet)?;
    }
    for (asset, amount) in sheet.residues() {
        let counterparty = capital_counterparty(wallet, tx, decoded, asset);
        let kind = classify(wallet, tx, (asset, amount), counterparty);
        sheet.book(asset, amount, kind)?;
    }
    Ok(())
}

pub(super) fn classify(
    wallet: &WalletContext,
    tx: &TransactionView,
    change: (Asset, i128),
    counterparty: Counterparty,
) -> EntryKind {
    let (asset, amount) = change;
    let root = tx
        .instructions
        .iter()
        .find(|node| node.position.inner.is_none() && !is_neutral_program(node.program))
        .map(|node| node.program);
    match root {
        Some(program) => {
            if let Some(bridge) = wallet.bridges.get(&program) {
                capital(amount, Counterparty::Bridge(*bridge))
            } else if wallet.services.contains(&program) && amount < 0 {
                EntryKind::ServiceFee { program }
            } else {
                EntryKind::ProtocolActivity { program }
            }
        }
        None if amount < 0 && !is_wallet_signer(wallet.wallet, tx) => {
            let program = match asset {
                Asset::Token { mint }
                    if tx.token_balances.iter().any(|balance| {
                        balance.mint == mint && balance.program == TokenProgram::Token2022
                    }) =>
                {
                    TOKEN_2022_PROGRAM
                }
                Asset::Token { .. } => TOKEN_PROGRAM,
                Asset::Sol | Asset::Rent => SYSTEM_PROGRAM,
            };
            EntryKind::ProtocolActivity { program }
        }
        None => capital(amount, counterparty),
    }
}

fn capital(amount: i128, counterparty: Counterparty) -> EntryKind {
    if amount > 0 {
        EntryKind::CapitalDeposit { counterparty }
    } else {
        EntryKind::CapitalWithdrawal { counterparty }
    }
}

fn capital_counterparty(
    wallet: &WalletContext,
    tx: &TransactionView,
    decoded: &Decoded,
    asset: Asset,
) -> Counterparty {
    let mut addresses = Vec::new();
    for (_, instruction) in decoded {
        let other = match asset {
            Asset::Sol => native_funding(instruction).and_then(|(from, to, _)| {
                if from == wallet.wallet {
                    Some(account_owner(tx, to).unwrap_or(to))
                } else if to == wallet.wallet {
                    Some(account_owner(tx, from).unwrap_or(from))
                } else {
                    None
                }
            }),
            Asset::Token { mint } => {
                token_transfer(instruction, tx).and_then(|(from, to, moved, _, _)| {
                    if mint != moved {
                        return None;
                    }
                    let owner = |account| {
                        tx.token_balances
                            .iter()
                            .find(|balance| balance.account == account)
                            .and_then(|balance| balance.owner_post.or(balance.owner_pre))
                    };
                    match (owner(from), owner(to)) {
                        (Some(from), Some(to)) if from == wallet.wallet => Some(to),
                        (Some(from), Some(to)) if to == wallet.wallet => Some(from),
                        _ => None,
                    }
                })
            }
            Asset::Rent => None,
        };
        let other = other.or_else(|| wrapped_counterparty(wallet.wallet, tx, instruction, asset));
        if let Some(address) = other
            && address != wallet.wallet
            && !addresses.contains(&address)
        {
            addresses.push(address);
        }
    }
    match addresses.as_slice() {
        [address] if wallet.is_tracked(*address) => Counterparty::TrackedWallet(*address),
        [address] => Counterparty::External {
            address: Some(*address),
        },
        _ => Counterparty::External { address: None },
    }
}

fn native_funding(instruction: &ProgramInstruction) -> Option<(Address, Address, i128)> {
    native_transfer(instruction).or_else(|| match instruction {
        ProgramInstruction::System(
            SystemInstruction::CreateAccount {
                funder,
                account,
                lamports,
                ..
            }
            | SystemInstruction::CreateAccountWithSeed {
                funder,
                account,
                lamports,
                ..
            },
        ) => Some((*funder, *account, i128::from(lamports.0))),
        _ => None,
    })
}

fn account_owner(tx: &TransactionView, account: Address) -> Option<Address> {
    tx.token_balances
        .iter()
        .find(|balance| balance.account == account)
        .and_then(|balance| balance.owner_post.or(balance.owner_pre))
}

fn wrapped_counterparty(
    wallet: Address,
    tx: &TransactionView,
    instruction: &ProgramInstruction,
    asset: Asset,
) -> Option<Address> {
    let mint = binsight_solana::well_known::WSOL_MINT;
    if asset == (Asset::Token { mint })
        && let Some((from, to, _)) = native_funding(instruction)
        && from != wallet
        && tx.token_balances.iter().any(|balance| {
            balance.account == to
                && balance.mint == mint
                && (balance.owner_pre == Some(wallet) || balance.owner_post == Some(wallet))
        })
    {
        return Some(from);
    }
    if let ProgramInstruction::Token {
        instruction:
            TokenInstruction::CloseAccount {
                account,
                destination,
                ..
            },
        ..
    } = instruction
    {
        let balance = tx
            .token_balances
            .iter()
            .find(|balance| balance.account == *account)?;
        if balance.owner_pre == Some(wallet)
            && balance.mint == mint
            && asset == (Asset::Token { mint })
        {
            return Some(*destination);
        }
        if *destination == wallet && asset == Asset::Sol {
            return balance.owner_pre;
        }
    }
    None
}

fn is_wallet_signer(wallet: Address, tx: &TransactionView) -> bool {
    tx.accounts
        .iter()
        .any(|account| account.address == wallet && account.is_signer)
}
