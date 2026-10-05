//! The canonical decimal string every amount, price and percentage travels as.

use binsight_core::ratio::Percent;
use serde::Serialize;
use utoipa::ToSchema;

/// An exact decimal number written as text: no exponent, no `+`, no leading zero, no trailing
/// zero after the point, never `-0`. For example `"61.541203117"`, `"-0.949"`, `"0"`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ToSchema)]
#[schema(value_type = String, pattern = r"^-?(0|[1-9][0-9]*)(\.[0-9]*[1-9])?$", example = "-1.25")]
pub(crate) struct DecimalString(String);

impl DecimalString {
    /// Wraps text that is already canonical (it comes from `binsight_core::decimal`).
    pub(crate) fn from_canonical(text: String) -> Self {
        Self(text)
    }
}

impl From<Percent> for DecimalString {
    fn from(percent: Percent) -> Self {
        Self(percent.to_decimal_string())
    }
}
