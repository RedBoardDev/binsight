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
