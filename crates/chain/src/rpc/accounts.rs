//! `getMultipleAccounts`: up to a hundred accounts read in one request, at one slot.
//!
//! Accounts are read at `finalized` commitment, the same as transactions, so what they hold can be
//! compared with the registry. The node returns each account's data in base64; an optional slice
//! asks for only a few of its bytes, which keeps the answer small. A missing account is `None`, in
//! the order of the request. This module reads bytes; what they mean (a token amount, a pool) is
//! the domain's job.

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use binsight_solana::{Address, Commitment};
use serde::Deserialize;

use crate::error::RpcError;
use crate::rpc::call::CallContext;
use crate::rpc::client::RpcClient;
use crate::rpc::envelope::RpcResult;
use crate::rpc::method::RpcMethod;
use crate::rpc::wire_names::commitment_name;

/// The most accounts one request reads.
pub const ACCOUNT_BATCH_LIMIT: usize = 100;

/// The commitment accounts are read at.
const ACCOUNT_COMMITMENT: Commitment = Commitment::Finalized;

const METHOD: RpcMethod = RpcMethod::GetMultipleAccounts;

/// Between one and [`ACCOUNT_BATCH_LIMIT`] accounts, read in one request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AccountBatch(Vec<Address>);

/// Why a list of accounts cannot be read in one request.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum AccountBatchError {
    /// It names no account.
    #[error("a batch needs at least one account")]
    Empty,
    /// It names more accounts than one request reads.
    #[error("a batch reads at most {ACCOUNT_BATCH_LIMIT} accounts, not {0}")]
    TooLarge(usize),
}

impl AccountBatch {
    /// The batch of `accounts`, in this order.
    ///
    /// # Errors
    ///
    /// Returns an error if `accounts` is empty or longer than [`ACCOUNT_BATCH_LIMIT`].
    pub fn new(accounts: Vec<Address>) -> Result<Self, AccountBatchError> {
        match accounts.len() {
            0 => Err(AccountBatchError::Empty),
            count if count > ACCOUNT_BATCH_LIMIT => Err(AccountBatchError::TooLarge(count)),
            _ => Ok(Self(accounts)),
        }
    }

    /// The accounts, in the order they are read.
    pub fn accounts(&self) -> &[Address] {
        &self.0
    }
}

/// The bytes of each account's data to read: `length` bytes from `offset`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DataSlice {
    /// The first byte.
    pub offset: usize,
    /// How many bytes.
    pub length: usize,
}

/// One account, as the node returned it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AccountData {
    /// Its lamports.
    pub lamports: u64,
    /// The program that owns it.
    pub owner: Address,
    /// Its data, or the slice of it that was asked.
    pub data: Vec<u8>,
}

/// Accounts read together, at one slot.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AccountsAtSlot {
    /// The slot the node read them at.
    pub slot: u64,
    /// Each account of the batch, in its order; `None` when it does not exist.
    pub accounts: Vec<Option<AccountData>>,
}

#[derive(Deserialize)]
struct AccountsAnswer {
    context: SlotContext,
    value: Vec<Option<AccountFields>>,
}

#[derive(Deserialize)]
struct SlotContext {
    slot: u64,
}

#[derive(Deserialize)]
struct AccountFields {
    lamports: u64,
    owner: String,
    data: (String, String),
}

impl RpcClient {
    /// Reads every account of `batch` in one request, only the bytes of `slice` of their data
    /// when one is given.
    ///
    /// # Errors
    ///
    /// Returns an [`RpcError`] if the call fails after its retries or the answer cannot be read
    /// (it must hold one entry per account of the batch).
    pub async fn multiple_accounts(
        &self,
        batch: &AccountBatch,
        slice: Option<DataSlice>,
        context: CallContext,
    ) -> Result<AccountsAtSlot, RpcError> {
        let mut options = serde_json::Map::new();
        options.insert("encoding".to_owned(), "base64".into());
        options.insert(
            "commitment".to_owned(),
            commitment_name(ACCOUNT_COMMITMENT).into(),
        );
        if let Some(slice) = slice {
            options.insert(
                "dataSlice".to_owned(),
                serde_json::json!({"offset": slice.offset, "length": slice.length}),
            );
        }
        let accounts: Vec<String> = batch.accounts().iter().map(ToString::to_string).collect();
        let params = serde_json::json!([accounts, options]);
        match self.call(METHOD, &params, &context).await? {
            RpcResult::Null => Err(unreadable("the node returned null instead of accounts")),
            RpcResult::Value(raw) => read_accounts(raw.get(), batch.accounts().len()),
        }
    }
}

/// Reads the answer for a batch of `expected` accounts.
fn read_accounts(json: &str, expected: usize) -> Result<AccountsAtSlot, RpcError> {
    let answer: AccountsAnswer =
        serde_json::from_str(json).map_err(|error| unreadable(&error.to_string()))?;
    if answer.value.len() != expected {
        return Err(unreadable(&format!(
            "{} accounts returned for {expected} asked",
            answer.value.len()
        )));
    }
    let accounts = answer
        .value
        .into_iter()
        .map(|fields| fields.map(read_account).transpose())
        .collect::<Result<_, _>>()?;
    Ok(AccountsAtSlot {
        slot: answer.context.slot,
        accounts,
    })
}

fn read_account(fields: AccountFields) -> Result<AccountData, RpcError> {
    let (encoded, encoding) = fields.data;
    if encoding != "base64" {
        return Err(unreadable(&format!("account data in {encoding}")));
    }
    Ok(AccountData {
        lamports: fields.lamports,
        owner: fields
            .owner
            .parse()
            .map_err(|error: binsight_solana::ParseError| unreadable(&error.to_string()))?,
        data: STANDARD
            .decode(encoded)
            .map_err(|error| unreadable(&error.to_string()))?,
    })
}

fn unreadable(detail: &str) -> RpcError {
    RpcError::UnexpectedResponse {
        method: METHOD.name(),
        detail: detail.to_owned(),
    }
}

#[cfg(test)]
mod tests;
