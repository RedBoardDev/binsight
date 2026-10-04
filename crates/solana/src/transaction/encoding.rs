//! The encodings a Solana node can return a transaction in.
//!
//! This module only names them; requesting one is the job of the chain client.

/// The encoding requested from the node for a transaction.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum TxEncoding {
    /// `json`: the message as JSON, with compiled instructions.
    Json,
    /// `jsonParsed`: the node's own rendering of the known programs, which changes with its
    /// version.
    JsonParsed,
    /// `base64`: the signed transaction bytes exactly as they were sent to the cluster.
    Base64,
}
