//! What the provider bills, and what each item costs in credits.
//!
//! Helius bills standard Solana methods one credit per request; a request is one call, never a
//! batch. The WebSocket stream costs one credit per connection opened and two per started tenth
//! of a megabyte it delivers, counted over the whole connection. These prices are what the old
//! tracker's meter assumed; they are checked against the provider's dashboard during real runs
//! and corrected here, in one place.

use binsight_core::credits::Credits;

use crate::rpc::RpcMethod;

/// The bytes of streamed data billed as one unit.
pub(crate) const STREAM_DATA_UNIT_BYTES: u64 = 100_000;

/// What the provider bills.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum BilledMethod {
    /// One JSON-RPC request.
    Rpc(RpcMethod),
    /// Opening a WebSocket connection.
    StreamOpen,
    /// One started tenth of a megabyte of data delivered by a WebSocket connection.
    StreamData,
}

impl BilledMethod {
    /// The name the credit report files it under: the JSON-RPC method, or `ws_open`/`ws_data`.
    pub const fn name(self) -> &'static str {
        match self {
            Self::Rpc(method) => method.name(),
            Self::StreamOpen => "ws_open",
            Self::StreamData => "ws_data",
        }
    }
}

/// The credits one unit of `method` costs.
pub(crate) const fn cost(method: BilledMethod) -> Credits {
    match method {
        BilledMethod::Rpc(RpcMethod::GetSignaturesForAddress | RpcMethod::GetTransaction)
        | BilledMethod::StreamOpen => Credits(1),
        BilledMethod::StreamData => Credits(2),
    }
}
