//! The JSON-RPC side of the chain client: the transports, the client and its typed methods.
//!
//! Requests go one by one, never as JSON-RPC batches: the free plan refuses batches, and a batch
//! is a burst the pacing cannot smooth. Each typed method builds its parameters and reads its own
//! result; the client handles deadlines and retries for all of them.

mod accounts;
mod call;
mod client;
mod envelope;
mod exchange;
mod http_transport;
mod method;
mod retry;
mod signatures;
mod transaction;
mod transport;
mod wire_names;

pub use accounts::{
    ACCOUNT_BATCH_LIMIT, AccountBatch, AccountBatchError, AccountData, AccountsAtSlot, DataSlice,
};
pub use call::CallContext;
pub use client::RpcClient;
pub use http_transport::HttpTransport;
pub use method::RpcMethod;
pub use signatures::{SIGNATURE_PAGE_LIMIT, SignatureInfo, SignaturesRequest};
pub use transaction::{RawTransaction, TransactionLookup};
pub use transport::{HttpReply, RpcTransport, SendFuture};
