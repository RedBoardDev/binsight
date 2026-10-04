//! The account list of a transaction: the static accounts, then the ones loaded from lookup tables.
//!
//! Instructions and balances refer to accounts by their index in this list: the message's own
//! accounts first, then every account loaded as writable, then every account loaded as read-only,
//! table after table. The addresses loaded from tables come from the node's meta, since only the
//! table's content at the time of the transaction says what they were. This module builds the
//! list; it does not look at instructions.

use super::error::TransactionReadError;
use super::wire::{MessageHeader, WireFormat, WireTransaction};
use crate::Address;

/// One account of a transaction.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AccountKey {
    /// The account address.
    pub address: Address,
    /// Whether the account signs the transaction (the first signer pays the fee).
    pub is_signer: bool,
    /// Whether the message requests the account as writable. The runtime may still demote a
    /// program or a reserved account to read-only.
    pub is_writable: bool,
    /// Where the address comes from.
    pub source: AccountSource,
}

/// Where the address of an account comes from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AccountSource {
    /// The message lists it.
    Message,
    /// A version 0 transaction loaded it from this address lookup table.
    LookupTable {
        /// The lookup table account.
        table: Address,
    },
}

/// The address of the account at `index`.
pub(super) fn address_at(
    accounts: &[AccountKey],
    index: u8,
) -> Result<Address, TransactionReadError> {
    accounts
        .get(usize::from(index))
        .map(|account| account.address)
        .ok_or(TransactionReadError::AccountIndexOutOfRange {
            index,
            accounts: accounts.len(),
        })
}

/// The addresses the meta says the lookup tables loaded, in list order.
#[derive(Debug, Default)]
pub(super) struct LoadedAddresses {
    /// Loaded as writable.
    pub(super) writable: Vec<Address>,
    /// Loaded as read-only.
    pub(super) readonly: Vec<Address>,
}

/// Builds the account list of `transaction` with the addresses its lookup tables `loaded`.
pub(super) fn resolve(
    transaction: &WireTransaction,
    loaded: LoadedAddresses,
) -> Result<Vec<AccountKey>, TransactionReadError> {
    let mut accounts = static_accounts(transaction)?;
    let tables = match &transaction.format {
        WireFormat::V0 { lookups } => lookups.as_slice(),
        WireFormat::Legacy | WireFormat::V1 { .. } => &[],
    };
    let writable_tables = tables
        .iter()
        .flat_map(|lookup| lookup.writable_indexes.iter().map(move |_| lookup.table));
    let readonly_tables = tables
        .iter()
        .flat_map(|lookup| lookup.readonly_indexes.iter().map(move |_| lookup.table));
    accounts.extend(loaded_accounts(
        LoadedAs::Writable,
        writable_tables.collect(),
        loaded.writable,
    )?);
    accounts.extend(loaded_accounts(
        LoadedAs::ReadOnly,
        readonly_tables.collect(),
        loaded.readonly,
    )?);
    Ok(accounts)
}

/// The accounts the message lists, with the signer and writable flags its header gives them.
fn static_accounts(transaction: &WireTransaction) -> Result<Vec<AccountKey>, TransactionReadError> {
    let keys = &transaction.static_keys;
    let header = transaction.header;
    let invalid = || TransactionReadError::InvalidHeader {
        required_signatures: header.required_signatures,
        readonly_signed: header.readonly_signed,
        readonly_unsigned: header.readonly_unsigned,
        signatures: transaction.signatures.len(),
        accounts: keys.len(),
    };
    let limits = WritableLimits::of(header, keys.len()).ok_or_else(invalid)?;
    if transaction.signatures.len() < limits.signers {
        return Err(invalid());
    }
    Ok(keys
        .iter()
        .enumerate()
        .map(|(index, &address)| {
            let is_signer = index < limits.signers;
            let is_writable = if is_signer {
                index < limits.writable_signers
            } else {
                index < limits.writable_accounts
            };
            AccountKey {
                address,
                is_signer,
                is_writable,
                source: AccountSource::Message,
            }
        })
        .collect())
}

/// Where the signers and the writable accounts end in the static account list.
struct WritableLimits {
    signers: usize,
    writable_signers: usize,
    writable_accounts: usize,
}

impl WritableLimits {
    /// The limits the header sets, or `None` if they do not fit `accounts` accounts or leave the
    /// fee payer (the first signer) read-only.
    fn of(header: MessageHeader, accounts: usize) -> Option<Self> {
        let signers = usize::from(header.required_signatures);
        let writable_signers = signers.checked_sub(usize::from(header.readonly_signed))?;
        let writable_accounts = accounts.checked_sub(usize::from(header.readonly_unsigned))?;
        let fits = writable_signers > 0 && signers <= accounts && writable_accounts >= signers;
        fits.then_some(Self {
            signers,
            writable_signers,
            writable_accounts,
        })
    }
}

/// How a lookup table loads an account.
#[derive(Clone, Copy)]
enum LoadedAs {
    Writable,
    ReadOnly,
}

/// The accounts loaded `access`, each attributed to the table it comes from.
fn loaded_accounts(
    access: LoadedAs,
    tables: Vec<Address>,
    addresses: Vec<Address>,
) -> Result<Vec<AccountKey>, TransactionReadError> {
    if tables.len() != addresses.len() {
        return Err(TransactionReadError::LoadedAddressesMismatch {
            kind: match access {
                LoadedAs::Writable => "writable",
                LoadedAs::ReadOnly => "read-only",
            },
            expected: tables.len(),
            found: addresses.len(),
        });
    }
    Ok(tables
        .into_iter()
        .zip(addresses)
        .map(|(table, address)| AccountKey {
            address,
            is_signer: false,
            is_writable: matches!(access, LoadedAs::Writable),
            source: AccountSource::LookupTable { table },
        })
        .collect())
}
