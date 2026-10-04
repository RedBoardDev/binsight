//! # binsight-chain
//!
//! **Responsibility:** the only crate that talks to the Solana network, through Helius: the
//! JSON-RPC client, its transports and retries (later the WebSocket stream, the credit counter
//! and the budget governor). It knows nothing about DLMM, the database or the engine.
//!
//! **May depend on:** `binsight-core`, `binsight-solana`.
//! **Must not depend on:** `binsight-dlmm`, `binsight-ledger`, `binsight-store`, `binsight-engine`,
//! `binsight-api`.
//! (Checked in CI by `cargo xtask layering`.)
//!
//! **Start here:** [`RpcClient`], built on an [`HttpTransport`] to an [`RpcEndpoint`]. Tests of
//! the crates above use the scripted transport of the `test-support` feature instead, so no test
//! ever reaches the network.

mod endpoint;
mod error;
mod helius_key;
mod rpc;
#[cfg(any(test, feature = "test-support"))]
pub mod test_support;

pub use endpoint::RpcEndpoint;
pub use error::{RpcError, TransportError};
pub use helius_key::{HeliusApiKey, HeliusKeyError};
pub use rpc::{
    CallContext, HttpReply, HttpTransport, RawTransaction, RpcClient, RpcMethod, RpcTransport,
    SIGNATURE_PAGE_LIMIT, SendFuture, SignatureInfo, SignaturesRequest, TransactionLookup,
};
