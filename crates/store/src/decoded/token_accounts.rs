//! The token accounts each tracked wallet holds, as the registry last saw them.
//!
//! With its verdict on a transaction, the decoder records the balance the transaction left in
//! each token account a tracked wallet owned before or after it. Only the newest transaction of
//! each account counts, by slot then index in the block, so the order the registry is read in
//! does not matter, and a transaction decoded again writes the same row. Amounts are stored as
//! exact decimal text. This module stores what the decoder read; comparing it with the chain is
//! the engine's job.

use binsight_core::units::RawTokenAmount;
use binsight_solana::{Address, Signature};
use rusqlite::{Connection, Row, params};

use super::statements::replace_record;
use super::{DecodeRecord, DecodedRepo};
use crate::database::Database;
use crate::database::codec::{flag_from_sql, flag_to_sql, parse_from_sql, u32_from_sql};
use crate::database::codec::{unsigned_from_sql, unsigned_to_sql};
use crate::error::StoreError;
use crate::store::Store;

const UPSERT: &str = "
    INSERT INTO wallet_token_account (wallet, token_account, mint, last_signature, last_slot,
                                      last_index, last_amount, is_owned)
    SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8 WHERE EXISTS (SELECT 1 FROM wallet WHERE address = ?1)
    ON CONFLICT (wallet, token_account) DO UPDATE
    SET mint = excluded.mint, last_signature = excluded.last_signature,
        last_slot = excluded.last_slot, last_index = excluded.last_index,
        last_amount = excluded.last_amount, is_owned = excluded.is_owned
    WHERE (excluded.last_slot, coalesce(excluded.last_index, -1))
          >= (wallet_token_account.last_slot, coalesce(wallet_token_account.last_index, -1))";
const SELECT_OWNED: &str = "
    SELECT wallet, token_account, mint, last_signature, last_slot, last_index, last_amount,
           is_owned
    FROM wallet_token_account WHERE is_owned = 1 ORDER BY wallet, token_account";

/// What a registry transaction left in a token account a tracked wallet owned before or after it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TokenAccountBalance {
    /// The wallet.
    pub wallet: Address,
    /// The token account.
    pub token_account: Address,
    /// The token it holds.
    pub mint: Address,
    /// The transaction.
    pub signature: Signature,
    /// Its slot.
    pub slot: u64,
    /// Its index in its block, when the node reported it.
    pub transaction_index: Option<u32>,
    /// The account's raw amount after it.
    pub amount: RawTokenAmount,
    /// Whether the wallet owns the account after it (false once closed or handed over).
    pub is_owned: bool,
}

/// Reads the token accounts the wallets hold. Get one with [`Store::token_accounts`].
#[derive(Debug, Clone)]
pub struct TokenAccountsRepo {
    database: Database,
}

impl Store {
    /// The token accounts the tracked wallets hold, as the registry last saw them.
    pub fn token_accounts(&self) -> TokenAccountsRepo {
        TokenAccountsRepo {
            database: self.database().clone(),
        }
    }
}

impl DecodedRepo {
    /// Replaces the result of `record.decoder` on `record.signature` with `record` and records
    /// the balances it read in the tracked wallets' token accounts, in one transaction. A balance
    /// older than the one stored for its account, or of a wallet no longer tracked, is ignored.
    ///
    /// # Errors
    ///
    /// Returns an error if the raw transaction is not in the registry, or if the database cannot
    /// be written; nothing is changed then.
    pub async fn record_with_balances(
        &self,
        record: DecodeRecord,
        balances: Vec<TokenAccountBalance>,
    ) -> Result<(), StoreError> {
        self.database
            .write(move |connection| {
                let transaction = connection.transaction()?;
                replace_record(&transaction, &record)?;
                for balance in &balances {
                    upsert(&transaction, balance)?;
                }
                transaction.commit()?;
                Ok(())
            })
            .await
    }
}

impl TokenAccountsRepo {
    /// Every token account a tracked wallet owns, as the newest registry transaction that
    /// touched it left it, by wallet then account.
    ///
    /// # Errors
    ///
    /// Returns an error if the database cannot be read or holds an invalid row.
    pub async fn owned(&self) -> Result<Vec<TokenAccountBalance>, StoreError> {
        self.database
            .read(|connection| {
                let mut query = connection.prepare(SELECT_OWNED)?;
                let rows = query.query_map([], |row| Ok(balance_from_row(row)))?;
                rows.map(|row| row?).collect()
            })
            .await
    }
}

fn upsert(connection: &Connection, balance: &TokenAccountBalance) -> Result<(), StoreError> {
    connection.execute(
        UPSERT,
        params![
            balance.wallet.to_string(),
            balance.token_account.to_string(),
            balance.mint.to_string(),
            balance.signature.to_string(),
            unsigned_to_sql(balance.slot, "slot")?,
            balance.transaction_index,
            balance.amount.0.to_string(),
            flag_to_sql(balance.is_owned),
        ],
    )?;
    Ok(())
}

fn balance_from_row(row: &Row<'_>) -> Result<TokenAccountBalance, StoreError> {
    let amount: String = row.get(6)?;
    Ok(TokenAccountBalance {
        wallet: parse_from_sql(&row.get::<_, String>(0)?, "wallet address")?,
        token_account: parse_from_sql(&row.get::<_, String>(1)?, "token account")?,
        mint: parse_from_sql(&row.get::<_, String>(2)?, "mint")?,
        signature: parse_from_sql(&row.get::<_, String>(3)?, "signature")?,
        slot: unsigned_from_sql(row.get(4)?, "slot")?,
        transaction_index: row
            .get::<_, Option<i64>>(5)?
            .map(|index| u32_from_sql(index, "transaction index"))
            .transpose()?,
        amount: RawTokenAmount(parse_from_sql(&amount, "token amount")?),
        is_owned: flag_from_sql(row.get(7)?, "ownership flag")?,
    })
}

#[cfg(test)]
mod tests;
