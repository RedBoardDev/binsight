//! The errors of the Solana primitives.
//!
//! Parsing errors say which kind of value was being read and why it was refused, and where bytes
//! ran out. This module only describes failures; it does not log or recover from them.

use std::fmt;

/// Which kind of Solana value was being parsed, for error messages.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ValueKind {
    /// An account address (32 bytes).
    Address,
    /// A transaction signature (64 bytes).
    Signature,
}

impl fmt::Display for ValueKind {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let name = match self {
            Self::Address => "address",
            Self::Signature => "signature",
        };
        formatter.write_str(name)
    }
}

/// A base58 text could not be read as an address or a signature.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ParseError {
    /// The text is longer than any valid value of this kind; it is refused before decoding.
    #[error("the {kind} is longer than {max_characters} characters")]
    TooLong {
        /// What was being parsed.
        kind: ValueKind,
        /// The longest base58 text a valid value of this kind can have.
        max_characters: usize,
    },
    /// The text contains characters outside the base58 alphabet.
    #[error("the {kind} is not valid base58")]
    NotBase58 {
        /// What was being parsed.
        kind: ValueKind,
        /// The decoder's description of the problem.
        #[source]
        source: bs58::decode::Error,
    },
    /// The text is valid base58 but does not decode to the expected number of bytes.
    #[error("the {kind} decodes to {found} bytes instead of {expected}")]
    WrongLength {
        /// What was being parsed.
        kind: ValueKind,
        /// The number of bytes a value of this kind has.
        expected: usize,
        /// The number of bytes the text decoded to.
        found: usize,
    },
}

/// Bytes that could not be read as the value they should hold.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum MalformedBytes {
    /// The bytes end before the value.
    #[error("the bytes end before {what} (offset {offset})")]
    UnexpectedEnd {
        /// What was being read.
        what: &'static str,
        /// Where the value starts.
        offset: usize,
    },
    /// Bytes are left after the value.
    #[error("{count} bytes are left after {what}")]
    TrailingBytes {
        /// What was read.
        what: &'static str,
        /// How many bytes are left.
        count: usize,
    },
    /// A compact-u16 is longer than 3 bytes, above `u16::MAX`, or not in its shortest form.
    #[error("invalid compact-u16 for {what} (offset {offset})")]
    InvalidCompactU16 {
        /// What was being read.
        what: &'static str,
        /// Where the value starts.
        offset: usize,
    },
}
