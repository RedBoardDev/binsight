//! The errors of the core vocabulary.
//!
//! Each error says what went wrong in plain words; none of them carries a panic or a string type.
//! Callers decide what to do with them: this module never logs or recovers.

/// Checked arithmetic on an amount failed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum AmountError {
    /// The result is larger than the largest value the amount's integer type can hold.
    #[error("the amount is too large for its integer type")]
    Overflow,
    /// The result would be below zero; amounts are never negative.
    #[error("the amount would become negative")]
    Negative,
}

/// A decimal string could not be read as an amount.
///
/// The accepted form is digits, optionally followed by a decimal point and more digits, such as
/// `12`, `0.5` or `1.250`. Signs, exponents, spaces and separators are refused rather than guessed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum DecimalError {
    /// The text is empty.
    #[error("the decimal string is empty")]
    Empty,
    /// The text starts with `+` or `-`; only unsigned amounts can be parsed.
    #[error("the decimal string has a sign; only unsigned amounts are accepted")]
    Signed,
    /// The text contains something other than ASCII digits and one decimal point.
    #[error("the decimal string contains the invalid character {0:?}")]
    InvalidCharacter(char),
    /// The text contains more than one decimal point.
    #[error("the decimal string contains more than one decimal point")]
    MultiplePoints,
    /// A decimal point is not surrounded by digits on both sides (`.5` or `1.`).
    #[error("the decimal string needs digits on both sides of the decimal point")]
    MissingDigits,
    /// The text has more digits after the decimal point than the token has decimals.
    #[error("the decimal string has {found} digits after the point; the token has {allowed}")]
    TooManyDecimals {
        /// How many digits follow the decimal point in the text.
        found: usize,
        /// How many decimals the token has.
        allowed: u8,
    },
    /// The amount does not fit in a `u128` of raw units.
    #[error("the decimal string is too large for a raw token amount")]
    TooLarge,
}

/// A text is not the name of any value of a named enumeration (a priority, a purpose...).
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{text:?} is not a known {kind}")]
pub struct UnknownName {
    /// What kind of value was being read, such as `priority`.
    pub kind: &'static str,
    /// The text that matched no name.
    pub text: String,
}

impl UnknownName {
    /// The text `text` is not a known `kind`.
    pub fn new(kind: &'static str, text: &str) -> Self {
        Self {
            kind,
            text: text.to_owned(),
        }
    }
}
