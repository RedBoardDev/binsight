//! The bytes of a signed transaction, read into its parts, for every supported format.
//!
//! A legacy or version 0 transaction starts with its signatures, then its message, whose first
//! byte is `0x80 | version` when it is versioned. A version 1 transaction starts with `0x81` and
//! ends with its signatures. This module reads either into a [`WireTransaction`]; it does not
//! resolve lookup tables or decode instructions, and it refuses trailing bytes.

mod legacy;
mod v1;

use binsight_core::units::Lamports;

use super::error::TransactionReadError;
use super::version::TxVersion;
use crate::error::MalformedBytes;
use crate::{Address, Signature};

/// The high bit of the first byte of a versioned message (or of a version 1 transaction).
const VERSION_PREFIX: u8 = 0x80;

/// A transaction read from its bytes, before its accounts are resolved.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct WireTransaction {
    /// The signatures; the first one identifies the transaction.
    pub(super) signatures: Vec<Signature>,
    /// The three counts that say which static accounts sign and which are writable.
    pub(super) header: MessageHeader,
    /// The accounts listed in the message itself.
    pub(super) static_keys: Vec<Address>,
    /// The top-level instructions, in order.
    pub(super) instructions: Vec<CompiledInstruction>,
    /// What only some formats carry.
    pub(super) format: WireFormat,
}

/// The header of a message.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct MessageHeader {
    /// How many accounts, at the start of the list, sign the transaction.
    pub(super) required_signatures: u8,
    /// How many of the signers, at the end of the signers, are read-only.
    pub(super) readonly_signed: u8,
    /// How many of the other static accounts, at the end of the list, are read-only.
    pub(super) readonly_unsigned: u8,
}

/// A top-level instruction as the message stores it: indexes into the account list.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct CompiledInstruction {
    /// The index of the program account.
    pub(super) program_index: u8,
    /// The indexes of the accounts it is given, in order.
    pub(super) account_indexes: Vec<u8>,
    /// Its data.
    pub(super) data: Vec<u8>,
}

/// The parts that depend on the format.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum WireFormat {
    /// The original format.
    Legacy,
    /// Version 0: accounts may also be loaded from address lookup tables.
    V0 {
        /// The lookup tables, in order.
        lookups: Vec<LookupTableUse>,
    },
    /// Version 1: the compute budget is in the header.
    V1 {
        /// The resource requests of the header.
        config: TransactionConfig,
    },
}

/// The accounts a version 0 transaction loads from one address lookup table.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct LookupTableUse {
    /// The lookup table account.
    pub(super) table: Address,
    /// The positions in the table of the accounts loaded as writable.
    pub(super) writable_indexes: Vec<u8>,
    /// The positions in the table of the accounts loaded as read-only.
    pub(super) readonly_indexes: Vec<u8>,
}

/// The resource requests of a version 1 transaction; an absent value means the minimum.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub(super) struct TransactionConfig {
    /// The priority fee, as a total in lamports.
    pub(super) priority_fee: Option<Lamports>,
    /// The compute-unit limit.
    pub(super) compute_unit_limit: Option<u32>,
    /// The limit on the size of the account data the transaction loads, in bytes.
    pub(super) loaded_accounts_data_size_limit: Option<u32>,
    /// The requested heap size, in bytes.
    pub(super) heap_size: Option<u32>,
}

impl WireFormat {
    /// The format version.
    pub(super) fn version(&self) -> TxVersion {
        match self {
            Self::Legacy => TxVersion::Legacy,
            Self::V0 { .. } => TxVersion::V0,
            Self::V1 { .. } => TxVersion::V1,
        }
    }
}

/// Reads the bytes of a signed transaction, whatever its format.
pub(super) fn parse(bytes: &[u8]) -> Result<WireTransaction, TransactionReadError> {
    let first = *bytes.first().ok_or(MalformedBytes::UnexpectedEnd {
        what: "the transaction",
        offset: 0,
    })?;
    if first & VERSION_PREFIX == 0 {
        return legacy::parse(bytes);
    }
    match TxVersion::try_from(first & !VERSION_PREFIX)? {
        TxVersion::V1 => v1::parse(bytes),
        // A legacy or version 0 transaction starts with its signature count, a compact-u16:
        // 0x80 there would announce at least 128 signatures, which no transaction can hold.
        TxVersion::Legacy | TxVersion::V0 => Err(MalformedBytes::InvalidCompactU16 {
            what: "the signature count",
            offset: 0,
        }
        .into()),
    }
}
