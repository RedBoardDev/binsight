//! How much a figure can be trusted.
//!
//! Every figure binsight shows carries an [`Exactness`] next to its value, so an incomplete or
//! reconstructed number is never presented as an exact one. This module only defines the
//! statuses and how they combine; deciding which status a figure gets is the job of the code that
//! computes it.

/// The trust level of a computed figure.
///
/// The variants are declared from the most to the least trustworthy, and that order is the one
/// used by [`Exactness::combine`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Exactness {
    /// Every input was known exactly: the figure is exact to the smallest unit.
    Complete,
    /// A lower bound: some inputs could not be valued (for example a token without a price) and
    /// were left out; what is included is exact.
    Partial,
    /// The figure is reconstructed or approximated rather than measured (for example the history
    /// of a wallet before it was added).
    Estimated,
    /// The figure could not be computed at all.
    Unavailable,
}

impl Exactness {
    /// The status of a figure computed from two inputs with these statuses: the least
    /// trustworthy of the two wins.
    ///
    /// For example, adding an exact amount to an estimated one gives an estimated total.
    #[must_use]
    pub fn combine(self, other: Self) -> Self {
        std::cmp::max(self, other)
    }
}

#[cfg(test)]
mod tests {
    use super::Exactness::{Complete, Estimated, Partial, Unavailable};

    const ALL: [super::Exactness; 4] = [Complete, Partial, Estimated, Unavailable];

    #[test]
    fn keeps_complete_only_when_both_inputs_are_complete() {
        assert_eq!(Complete.combine(Complete), Complete);
        assert_eq!(Complete.combine(Partial), Partial);
        assert_eq!(Estimated.combine(Complete), Estimated);
    }

    #[test]
    fn keeps_the_least_trustworthy_status() {
        assert_eq!(Partial.combine(Estimated), Estimated);
        assert_eq!(Estimated.combine(Unavailable), Unavailable);
        assert_eq!(Unavailable.combine(Complete), Unavailable);
    }

    #[test]
    fn combines_in_any_order_and_any_grouping() {
        for a in ALL {
            assert_eq!(a.combine(a), a);
            for b in ALL {
                assert_eq!(a.combine(b), b.combine(a));
                for c in ALL {
                    assert_eq!(a.combine(b).combine(c), a.combine(b.combine(c)));
                }
            }
        }
    }
}
