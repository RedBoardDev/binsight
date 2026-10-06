//! A figure on the wire: a union tagged by its exactness, so an unavailable figure has no value.

use binsight_core::ratio::Percent;
use binsight_ledger::report::figure as ledger;
use binsight_ledger::report::valued;
use serde::Serialize;
use utoipa::ToSchema;

mod reason;

use super::decimal::DecimalString;
use super::money::Money;
use reason::Reason;

/// An amount and how far it can be trusted. `value` is present unless the figure is
/// `unavailable`; `reasons` say why a figure is not `complete`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ToSchema)]
#[serde(tag = "exactness", rename_all = "snake_case")]
pub(crate) enum Figure {
    /// Exact to the smallest unit.
    Complete {
        /// The amount.
        value: Money,
    },
    /// A lower bound: some inputs could not be valued and are left out.
    Partial {
        /// The amount of what could be valued.
        value: Money,
        /// Why it is partial.
        reasons: Vec<Reason>,
    },
    /// Reconstructed rather than measured.
    Estimated {
        /// The estimated amount.
        value: Money,
        /// Why it is estimated.
        reasons: Vec<Reason>,
    },
    /// Could not be computed.
    Unavailable {
        /// Why.
        reasons: Vec<Reason>,
    },
}

/// A percentage (`"2.56"` is 2.56 %) and how far it can be trusted, shaped like [`Figure`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ToSchema)]
#[serde(tag = "exactness", rename_all = "snake_case")]
pub(crate) enum PercentFigure {
    /// Exact.
    Complete {
        /// The percentage.
        value: DecimalString,
    },
    /// Computed from a lower bound.
    Partial {
        /// The percentage.
        value: DecimalString,
        /// Why it is partial.
        reasons: Vec<Reason>,
    },
    /// Computed from reconstructed figures.
    Estimated {
        /// The percentage.
        value: DecimalString,
        /// Why it is estimated.
        reasons: Vec<Reason>,
    },
    /// Could not be computed (for example a zero denominator).
    Unavailable {
        /// Why.
        reasons: Vec<Reason>,
    },
}

impl From<&ledger::Figure<valued::Money>> for Figure {
    fn from(figure: &ledger::Figure<valued::Money>) -> Self {
        let reasons = || reasons_of(figure);
        match figure {
            ledger::Figure::Complete(value) => Self::Complete {
                value: (*value).into(),
            },
            ledger::Figure::Partial { value, .. } => Self::Partial {
                value: (*value).into(),
                reasons: reasons(),
            },
            ledger::Figure::Estimated { value, .. } => Self::Estimated {
                value: (*value).into(),
                reasons: reasons(),
            },
            ledger::Figure::Unavailable { .. } => Self::Unavailable { reasons: reasons() },
        }
    }
}

impl From<&ledger::Figure<Percent>> for PercentFigure {
    fn from(figure: &ledger::Figure<Percent>) -> Self {
        let reasons = || reasons_of(figure);
        match figure {
            ledger::Figure::Complete(value) => Self::Complete {
                value: (*value).into(),
            },
            ledger::Figure::Partial { value, .. } => Self::Partial {
                value: (*value).into(),
                reasons: reasons(),
            },
            ledger::Figure::Estimated { value, .. } => Self::Estimated {
                value: (*value).into(),
                reasons: reasons(),
            },
            ledger::Figure::Unavailable { .. } => Self::Unavailable { reasons: reasons() },
        }
    }
}

/// The wire reasons of a figure, in a stable order.
fn reasons_of<T>(figure: &ledger::Figure<T>) -> Vec<Reason> {
    figure.reasons().iter().map(Reason::from).collect()
}

#[cfg(test)]
mod tests {
    use binsight_ledger::report::figure::{Reason as LedgerReason, Reasons};

    use super::*;

    fn sol(raw: i128) -> valued::Money {
        valued::Money {
            raw,
            unit: valued::MoneyUnit::Sol,
        }
    }

    #[test]
    fn writes_a_complete_figure_without_reasons() {
        let figure = Figure::from(&ledger::Figure::Complete(sol(61_541_203_117)));
        assert_eq!(
            serde_json::to_string(&figure).unwrap(),
            r#"{"exactness":"complete","value":{"amount":"61.541203117","unit":"sol"}}"#
        );
    }

    #[test]
    fn writes_an_unavailable_figure_without_a_value() {
        let reasons = Reasons::from([LedgerReason::ZeroDenominator]);
        let figure = PercentFigure::from(&ledger::Figure::<Percent>::Unavailable { reasons });
        assert_eq!(
            serde_json::to_string(&figure).unwrap(),
            r#"{"exactness":"unavailable","reasons":[{"code":"zero_denominator"}]}"#
        );
    }

    #[test]
    fn keeps_the_sign_in_the_amount() {
        let reasons = Reasons::from([LedgerReason::NoUsdRate]);
        let figure = Figure::from(&ledger::Figure::Estimated {
            value: sol(-949_000_000),
            reasons,
        });
        let json = serde_json::to_value(&figure).unwrap();
        assert_eq!(json["value"]["amount"], "-0.949");
        assert_eq!(json["exactness"], "estimated");
    }
}
