//! The SOL and token balances of the accounts of a transaction, before and after it.
//!
//! Native balances come as two lists in account order. Token balances come as two sparse lists
//! (an account created or closed by the transaction is missing on one side), which are merged per
//! account: a missing side counts as zero, with no owner. Amounts are read from the exact integer
//! strings, never from the floating-point `uiAmount`. This module only reads balances; it does not
//! decide whose they are.

use std::collections::BTreeMap;

use binsight_core::units::{Decimals, Lamports, RawTokenAmount};

use super::accounts::{AccountKey, address_at};
use super::error::TransactionReadError;
use super::parse_address;
use super::rpc_response::RpcTokenBalance;
use crate::Address;
use crate::programs::TokenProgram;

/// The lamports of one account before and after the transaction.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct NativeBalance {
    /// The account.
    pub account: Address,
    /// Its lamports before.
    pub pre: Lamports,
    /// Its lamports after.
    pub post: Lamports,
}

/// The tokens of one token account before and after the transaction.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TokenBalance {
    /// The token account.
    pub account: Address,
    /// The mint of the token.
    pub mint: Address,
    /// The program that owns the token account.
    pub program: TokenProgram,
    /// The decimals of the mint.
    pub decimals: Decimals,
    /// The owner before, or `None` if the account did not exist (or the node did not say).
    pub owner_pre: Option<Address>,
    /// The owner after, or `None` if the account no longer exists (or the node did not say).
    pub owner_post: Option<Address>,
    /// The amount before, zero if the account did not exist.
    pub pre: RawTokenAmount,
    /// The amount after, zero if the account no longer exists.
    pub post: RawTokenAmount,
}

/// Pairs the native balances with their accounts.
pub(super) fn native(
    accounts: &[AccountKey],
    pre: &[u64],
    post: &[u64],
) -> Result<Vec<NativeBalance>, TransactionReadError> {
    for (which, list) in [("preBalances", pre), ("postBalances", post)] {
        if list.len() != accounts.len() {
            return Err(TransactionReadError::BalanceCountMismatch {
                which,
                found: list.len(),
                accounts: accounts.len(),
            });
        }
    }
    Ok(accounts
        .iter()
        .zip(pre.iter().zip(post))
        .map(|(account, (&pre, &post))| NativeBalance {
            account: account.address,
            pre: Lamports(pre),
            post: Lamports(post),
        })
        .collect())
}

/// One side (before or after) of a token account.
#[derive(Debug, Clone, Copy)]
struct TokenSide {
    mint: Address,
    program: TokenProgram,
    decimals: Decimals,
    owner: Option<Address>,
    amount: RawTokenAmount,
}

/// Merges the token balances before and after into one entry per token account, in account order.
///
/// An account closed and reopened for another mint in the same transaction gives two entries:
/// the old mint going to zero, then the new mint coming from zero.
pub(super) fn tokens(
    accounts: &[AccountKey],
    pre: &[RpcTokenBalance],
    post: &[RpcTokenBalance],
) -> Result<Vec<TokenBalance>, TransactionReadError> {
    let mut sides: BTreeMap<u8, (Option<TokenSide>, Option<TokenSide>)> = BTreeMap::new();
    for balance in pre {
        let side = token_side(accounts, balance)?;
        let entry = &mut sides.entry(balance.account_index).or_default().0;
        if entry.replace(side).is_some() {
            return Err(duplicate(balance, "preTokenBalances"));
        }
    }
    for balance in post {
        let side = token_side(accounts, balance)?;
        let entry = &mut sides.entry(balance.account_index).or_default().1;
        if entry.replace(side).is_some() {
            return Err(duplicate(balance, "postTokenBalances"));
        }
    }
    let mut merged = Vec::new();
    for (index, pair) in sides {
        let account = address_at(accounts, index)?;
        merged.extend(merge(account, pair)?);
    }
    Ok(merged)
}

fn duplicate(balance: &RpcTokenBalance, which: &'static str) -> TransactionReadError {
    TransactionReadError::DuplicateTokenBalance {
        which,
        index: balance.account_index,
    }
}

fn merge(
    account: Address,
    pair: (Option<TokenSide>, Option<TokenSide>),
) -> Result<Vec<TokenBalance>, TransactionReadError> {
    Ok(match pair {
        (None, None) => Vec::new(),
        (Some(before), None) => vec![balance(account, before, Some(before), None)],
        (None, Some(after)) => vec![balance(account, after, None, Some(after))],
        (Some(before), Some(after)) if before.mint != after.mint => vec![
            balance(account, before, Some(before), None),
            balance(account, after, None, Some(after)),
        ],
        (Some(before), Some(after)) => {
            if before.decimals != after.decimals || before.program != after.program {
                return Err(TransactionReadError::InconsistentTokenBalance { account });
            }
            vec![balance(account, before, Some(before), Some(after))]
        }
    })
}

/// The balance of `account` for the token of `token`, between two sides of the same mint (a
/// missing side counts as zero, without an owner).
fn balance(
    account: Address,
    token: TokenSide,
    before: Option<TokenSide>,
    after: Option<TokenSide>,
) -> TokenBalance {
    let amount = |side: Option<TokenSide>| side.map_or(RawTokenAmount::ZERO, |side| side.amount);
    TokenBalance {
        account,
        mint: token.mint,
        program: token.program,
        decimals: token.decimals,
        owner_pre: before.and_then(|side| side.owner),
        owner_post: after.and_then(|side| side.owner),
        pre: amount(before),
        post: amount(after),
    }
}

fn token_side(
    accounts: &[AccountKey],
    balance: &RpcTokenBalance,
) -> Result<TokenSide, TransactionReadError> {
    let account = address_at(accounts, balance.account_index)?;
    let program_text = balance
        .program_id
        .as_deref()
        .ok_or(TransactionReadError::MissingField { field: "programId" })?;
    let program_address = parse_address(program_text, "programId")?;
    let program =
        TokenProgram::of(program_address).ok_or(TransactionReadError::UnknownTokenProgram {
            account,
            program: program_address,
        })?;
    Ok(TokenSide {
        mint: parse_address(&balance.mint, "mint")?,
        program,
        decimals: Decimals(balance.ui_token_amount.decimals),
        owner: balance
            .owner
            .as_deref()
            .map(|owner| parse_address(owner, "owner"))
            .transpose()?,
        amount: parse_amount(&balance.ui_token_amount.amount)?,
    })
}

/// Parses a raw token amount: decimal digits only, no sign, no exponent.
fn parse_amount(text: &str) -> Result<RawTokenAmount, TransactionReadError> {
    let invalid = || TransactionReadError::InvalidTokenAmount {
        amount: text.to_owned(),
    };
    if text.is_empty() || !text.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(invalid());
    }
    text.parse().map(RawTokenAmount).map_err(|_| invalid())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn side(mint: u8, amount: u128) -> TokenSide {
        TokenSide {
            mint: Address::from_bytes([mint; 32]),
            program: TokenProgram::Token,
            decimals: Decimals(6),
            owner: Some(Address::from_bytes([9; 32])),
            amount: RawTokenAmount(amount),
        }
    }

    #[test]
    fn reads_only_plain_decimal_integers_as_amounts() {
        assert_eq!(
            parse_amount("900719925474099312345").unwrap(),
            RawTokenAmount(900_719_925_474_099_312_345)
        );
        for refused in ["", "+5", "-5", "1e3", "1.0", " 7"] {
            assert!(parse_amount(refused).is_err(), "{refused}");
        }
    }

    #[test]
    fn splits_an_account_reopened_for_another_mint_into_a_close_and_an_open() {
        let account = Address::from_bytes([1; 32]);
        let entries = merge(account, (Some(side(2, 50)), Some(side(3, 70)))).unwrap();
        let summary: Vec<_> = entries
            .iter()
            .map(|entry| (entry.mint, entry.pre, entry.post))
            .collect();
        assert_eq!(
            summary,
            [
                (side(2, 0).mint, RawTokenAmount(50), RawTokenAmount::ZERO),
                (side(3, 0).mint, RawTokenAmount::ZERO, RawTokenAmount(70)),
            ]
        );
        assert_eq!(entries[0].owner_post, None);
        assert_eq!(entries[1].owner_pre, None);
    }

    #[test]
    fn refuses_a_token_account_whose_decimals_change_without_its_mint() {
        let mut after = side(2, 1);
        after.decimals = Decimals(9);
        let account = Address::from_bytes([1; 32]);
        assert!(matches!(
            merge(account, (Some(side(2, 1)), Some(after))),
            Err(TransactionReadError::InconsistentTokenBalance { .. })
        ));
    }
}
