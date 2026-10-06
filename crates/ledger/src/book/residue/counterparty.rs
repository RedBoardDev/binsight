//! Find the other side of a capital move: the one address a transaction sends an asset to, or
//! receives it from, when there is exactly one.

use super::super::instructions::{Decoded, native_transfer, token_transfer};
use super::super::{Asset, Counterparty, WalletContext};
use binsight_solana::transaction::TransactionView;
use binsight_solana::{
    Address,
    programs::{ProgramInstruction, SystemInstruction, TokenInstruction},
};

pub(super) fn capital_counterparty(
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

pub(super) fn native_funding(instruction: &ProgramInstruction) -> Option<(Address, Address, i128)> {
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

pub(super) fn account_owner(tx: &TransactionView, account: Address) -> Option<Address> {
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
