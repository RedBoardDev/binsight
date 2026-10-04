//! How final a piece of chain data is when a node returns it.
//!
//! This module only names the levels binsight uses; asking a node for one of them is the job of
//! the chain client, and storing it is the job of the store.

/// How final the data was when the node returned it.
///
/// binsight never uses `processed`: a block at that level may still be skipped by the cluster.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Commitment {
    /// Voted on by a supermajority of the cluster, not yet rooted: it can still disappear on a
    /// fork.
    Confirmed,
    /// Rooted: it can no longer be rolled back.
    Finalized,
}
