//! Where the figures the API serves come from.

use std::sync::Arc;

use super::read_model::ReadModel;

/// Where the figures come from.
#[derive(Clone)]
pub enum DataSource {
    /// The engine computes them from the chain (the normal mode).
    Chain,
    /// A generated world stands in for the chain; nothing is tracked.
    Demo(Arc<dyn ReadModel>),
}

/// Which source serves the figures, without the source itself.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum DataSourceKind {
    /// The chain.
    Chain,
    /// A generated demo world.
    Demo,
}

impl DataSource {
    /// Which source this is.
    pub fn kind(&self) -> DataSourceKind {
        match self {
            Self::Chain => DataSourceKind::Chain,
            Self::Demo(_) => DataSourceKind::Demo,
        }
    }
}

impl std::fmt::Debug for DataSource {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{:?}", self.kind())
    }
}
