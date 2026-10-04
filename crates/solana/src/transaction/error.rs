//! Why a transaction could not be read.
//!
//! Every way the node's answer can disagree with itself or with the transaction format has its own
//! variant, so a refused transaction says exactly what is wrong. This module only describes
//! failures; it does not recover from them.

use binsight_core::units::Lamports;

use super::version::{TxVersion, UnsupportedTxVersion};
use crate::Address;
use crate::error::{MalformedBytes, ParseError};

/// A `getTransaction` result that cannot be read into a [`super::TransactionView`].
#[derive(Debug, thiserror::Error)]
pub enum TransactionReadError {
    /// The result is not JSON, or misses a field.
    #[error("the transaction is not the JSON a node returns")]
    Json(#[source] serde_json::Error),
    /// The transaction is not base64 (it was requested with another encoding).
    #[error("the transaction is encoded as `{encoding}` instead of base64")]
    UnsupportedEncoding {
        /// The encoding the node reports.
        encoding: String,
    },
    /// The base64 text cannot be decoded.
    #[error("the transaction is not valid base64")]
    Base64(#[source] base64::DecodeError),
    /// The transaction bytes end too early or hold an invalid count.
    #[error("the transaction bytes are malformed")]
    Malformed(#[from] MalformedBytes),
    /// The transaction uses a version binsight cannot read.
    #[error(transparent)]
    UnsupportedVersion(#[from] UnsupportedTxVersion),
    /// A version prefix appears where that version's layout cannot be.
    #[error("a {version:?} message cannot follow the signatures")]
    MisplacedVersion {
        /// The version the prefix announces.
        version: TxVersion,
    },
    /// A version 1 config mask sets a bit binsight does not know.
    #[error("the config mask {mask:#b} sets a bit binsight does not know")]
    UnknownConfigBits {
        /// The mask.
        mask: u32,
    },
    /// A version 1 config mask sets only one of the two priority-fee bits.
    #[error("the config mask {mask:#b} sets only one of the two priority-fee bits")]
    SplitPriorityFee {
        /// The mask.
        mask: u32,
    },
    /// The message header does not fit its accounts or its signatures.
    #[error(
        "the message header ({required_signatures} signers, {readonly_signed} read-only signers, \
         {readonly_unsigned} other read-only accounts) does not fit {signatures} signatures and \
         {accounts} accounts"
    )]
    InvalidHeader {
        /// The number of required signatures.
        required_signatures: u8,
        /// The number of read-only signers.
        readonly_signed: u8,
        /// The number of read-only accounts that do not sign.
        readonly_unsigned: u8,
        /// The number of signatures in the transaction.
        signatures: usize,
        /// The number of static accounts.
        accounts: usize,
    },
    /// The `version` field of the answer disagrees with the transaction bytes.
    #[error("the answer says {declared:?} but the bytes are {read:?}")]
    VersionMismatch {
        /// The version in the answer.
        declared: TxVersion,
        /// The version of the bytes.
        read: TxVersion,
    },
    /// The `version` field is a name other than `legacy`.
    #[error("the version `{name}` is unknown")]
    UnknownVersionName {
        /// The name in the answer.
        name: String,
    },
    /// A field the node only omits for very old transactions is missing.
    #[error("the transaction has no `{field}`")]
    MissingField {
        /// The JSON field.
        field: &'static str,
    },
    /// A base58 address in the answer is invalid.
    #[error("the `{field}` address is invalid")]
    InvalidAddress {
        /// The JSON field.
        field: &'static str,
        /// Why it is invalid.
        #[source]
        source: ParseError,
    },
    /// The lookup tables and the meta disagree on how many accounts were loaded.
    #[error("the lookup tables load {expected} {kind} accounts but the meta lists {found}")]
    LoadedAddressesMismatch {
        /// `writable` or `read-only`.
        kind: &'static str,
        /// How many the lookup tables load.
        expected: usize,
        /// How many the meta lists.
        found: usize,
    },
    /// An instruction or a balance refers to an account that does not exist.
    #[error("account index {index} is out of range ({accounts} accounts)")]
    AccountIndexOutOfRange {
        /// The index.
        index: u8,
        /// The number of accounts.
        accounts: usize,
    },
    /// Inner instructions are listed for a top-level instruction that does not exist.
    #[error(
        "inner instructions are listed for top-level instruction {index}, which does not exist"
    )]
    InnerInstructionsWithoutParent {
        /// The index of the missing top-level instruction.
        index: u8,
    },
    /// The base58 data of an inner instruction is invalid.
    #[error("the data of an inner instruction is not base58")]
    InvalidInstructionData(#[source] bs58::decode::Error),
    /// The meta lists a different number of native balances than accounts.
    #[error("the meta lists {found} {which} for {accounts} accounts")]
    BalanceCountMismatch {
        /// `preBalances` or `postBalances`.
        which: &'static str,
        /// How many balances are listed.
        found: usize,
        /// How many accounts the transaction has.
        accounts: usize,
    },
    /// A token amount is not a canonical decimal integer.
    #[error("the token amount `{amount}` is not a decimal integer")]
    InvalidTokenAmount {
        /// The text of the amount.
        amount: String,
    },
    /// A token balance belongs to a program that is neither SPL Token nor Token-2022.
    #[error("the token account {account} belongs to {program}, which is not a token program")]
    UnknownTokenProgram {
        /// The token account.
        account: Address,
        /// The program the meta names.
        program: Address,
    },
    /// The same token account reports two decimals or two programs for one mint.
    #[error("the token account {account} changes its decimals or program without changing mint")]
    InconsistentTokenBalance {
        /// The token account.
        account: Address,
    },
    /// The block time is outside the range of a timestamp.
    #[error("the block time {seconds} is out of range")]
    InvalidBlockTime {
        /// The block time, in seconds since the Unix epoch.
        seconds: i64,
    },
    /// The fee is smaller than the part of it that can be explained.
    #[error("the fee of {total} is smaller than its {part} part of {expected}")]
    FeeTooSmall {
        /// `priority` or `signature`.
        part: &'static str,
        /// The total fee.
        total: Lamports,
        /// The part that should fit in it.
        expected: Lamports,
    },
}
