//! A figure with its exactness and the reasons for it, and how exactness combines.
//!
//! A [`Figure`] is complete, partial (a lower bound), estimated (reconstructed) or unavailable;
//! only an unavailable figure has no value, so the type cannot hold a value it should not show.
//! Combining figures follows one table: a sum keeps the least trustworthy status; a difference
//! becomes estimated when what is subtracted is partial (a lower bound minus a lower bound bounds
//! nothing); a quotient with a zero denominator is unavailable. Reasons are merged without
//! duplicates. This module does not decide which status a fact deserves.

mod combination;
mod reason;

use std::collections::BTreeSet;

use binsight_core::exactness::Exactness;

pub use combination::{Combination, sum_figures};
pub use reason::Reason;

/// The reasons attached to a figure, without duplicates and in a stable order.
pub type Reasons = BTreeSet<Reason>;

/// A value and how far it can be trusted.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Figure<T> {
    /// Exact to the smallest unit.
    Complete(T),
    /// A lower bound: some inputs could not be valued and are left out.
    Partial {
        /// The value of what could be valued.
        value: T,
        /// Why it is partial.
        reasons: Reasons,
    },
    /// Reconstructed rather than measured.
    Estimated {
        /// The estimated value.
        value: T,
        /// Why it is estimated.
        reasons: Reasons,
    },
    /// Could not be computed.
    Unavailable {
        /// Why.
        reasons: Reasons,
    },
}

impl<T> Figure<T> {
    /// A figure from its parts; an unavailable exactness drops the value.
    pub fn from_parts(value: T, exactness: Exactness, reasons: Reasons) -> Self {
        match exactness {
            Exactness::Complete => Self::Complete(value),
            Exactness::Partial => Self::Partial { value, reasons },
            Exactness::Estimated => Self::Estimated { value, reasons },
            Exactness::Unavailable => Self::Unavailable { reasons },
        }
    }

    /// An unavailable figure for one reason.
    pub fn unavailable(reason: Reason) -> Self {
        Self::Unavailable {
            reasons: Reasons::from([reason]),
        }
    }

    /// The exactness of the figure.
    pub fn exactness(&self) -> Exactness {
        match self {
            Self::Complete(_) => Exactness::Complete,
            Self::Partial { .. } => Exactness::Partial,
            Self::Estimated { .. } => Exactness::Estimated,
            Self::Unavailable { .. } => Exactness::Unavailable,
        }
    }

    /// The value, unless the figure is unavailable.
    pub fn value(&self) -> Option<&T> {
        match self {
            Self::Complete(value) | Self::Partial { value, .. } | Self::Estimated { value, .. } => {
                Some(value)
            }
            Self::Unavailable { .. } => None,
        }
    }

    /// The reasons of the figure (none for a complete one).
    pub fn reasons(&self) -> Reasons {
        match self {
            Self::Complete(_) => Reasons::new(),
            Self::Partial { reasons, .. }
            | Self::Estimated { reasons, .. }
            | Self::Unavailable { reasons } => reasons.clone(),
        }
    }

    /// The same figure with its value transformed.
    pub fn map<U>(self, transform: impl FnOnce(T) -> U) -> Figure<U> {
        let (value, exactness, reasons) = self.into_parts();
        match value {
            Some(value) => Figure::from_parts(transform(value), exactness, reasons),
            None => Figure::Unavailable { reasons },
        }
    }

    /// The same figure with its value transformed by a fallible function.
    ///
    /// # Errors
    ///
    /// Returns the error of `transform`.
    pub fn try_map<U, E>(self, transform: impl FnOnce(T) -> Result<U, E>) -> Result<Figure<U>, E> {
        let (value, exactness, reasons) = self.into_parts();
        Ok(match value {
            Some(value) => Figure::from_parts(transform(value)?, exactness, reasons),
            None => Figure::Unavailable { reasons },
        })
    }

    /// The same figure, made at most as trustworthy as `exactness`, with `reasons` added.
    #[must_use]
    pub fn degraded(self, exactness: Exactness, reasons: Reasons) -> Self {
        let (value, own, mut merged) = self.into_parts();
        merged.extend(reasons);
        match value {
            Some(value) => Self::from_parts(value, own.combine(exactness), merged),
            None => Self::Unavailable { reasons: merged },
        }
    }

    /// The value (if any), the exactness and the reasons.
    pub(super) fn into_parts(self) -> (Option<T>, Exactness, Reasons) {
        match self {
            Self::Complete(value) => (Some(value), Exactness::Complete, Reasons::new()),
            Self::Partial { value, reasons } => (Some(value), Exactness::Partial, reasons),
            Self::Estimated { value, reasons } => (Some(value), Exactness::Estimated, reasons),
            Self::Unavailable { reasons } => (None, Exactness::Unavailable, reasons),
        }
    }
}

#[cfg(test)]
mod tests {
    use binsight_core::exactness::Exactness::{Complete, Estimated};

    use super::*;

    #[test]
    fn degrades_a_figure_without_losing_its_value() {
        let degraded = Figure::Complete(4).degraded(Estimated, Reasons::from([Reason::NoLosses]));
        assert_eq!(degraded.exactness(), Estimated);
        assert_eq!(degraded.value(), Some(&4));
        assert_eq!(Figure::Complete(4).exactness(), Complete);
    }
}
