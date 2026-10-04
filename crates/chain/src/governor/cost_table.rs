//! What each JSON-RPC method costs, in provider credits.
//!
//! Helius bills standard Solana methods one credit per request; a request is one call, never a
//! batch. These prices are what the old tracker's meter assumed; they are checked against the
//! provider's dashboard during real runs and corrected here, in one place.

use binsight_core::credits::Credits;

use crate::rpc::RpcMethod;

/// The credits one request of `method` costs.
pub(crate) const fn cost(method: RpcMethod) -> Credits {
    match method {
        RpcMethod::GetSignaturesForAddress | RpcMethod::GetTransaction => Credits(1),
    }
}
