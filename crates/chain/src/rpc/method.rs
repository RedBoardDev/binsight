//! The JSON-RPC methods binsight calls, and how long each may take.
//!
//! Naming the methods as an enum keeps their spelling in one place and lets the client attach a
//! deadline (and the meter a price) to each. This module only names them; building their
//! parameters belongs to the method's own module.

use std::time::Duration;

/// How long a single-account or single-transaction request may take.
const STANDARD_TIMEOUT_SECS: u64 = 15;

/// A JSON-RPC method of the Solana API.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum RpcMethod {
    /// `getSignaturesForAddress`: a page of an address's transaction signatures.
    GetSignaturesForAddress,
    /// `getTransaction`: one transaction by signature.
    GetTransaction,
    /// `getMultipleAccounts`: up to a hundred accounts at one slot.
    GetMultipleAccounts,
}

impl RpcMethod {
    /// The method name, as sent in the request.
    pub const fn name(self) -> &'static str {
        match self {
            Self::GetSignaturesForAddress => "getSignaturesForAddress",
            Self::GetTransaction => "getTransaction",
            Self::GetMultipleAccounts => "getMultipleAccounts",
        }
    }

    /// How long one attempt may wait for the answer.
    pub(crate) const fn timeout(self) -> Duration {
        match self {
            Self::GetSignaturesForAddress | Self::GetTransaction | Self::GetMultipleAccounts => {
                Duration::from_secs(STANDARD_TIMEOUT_SECS)
            }
        }
    }
}
