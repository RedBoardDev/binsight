//! Where the figures the API serves come from.

/// Which source serves the figures.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum DataSourceKind {
    /// The engine computes them from the chain.
    Chain,
    /// A generated demo world stands in for the chain; nothing is tracked.
    Demo,
}
