//! # binsight-chain
//!
//! **Responsibility:** the only crate that talks to the Solana network, through Helius: the
//! JSON-RPC client, its transports and retries, the WebSocket stream that reports wallet
//! activity live, and the governor that paces requests, counts their credits and budgets them.
//! It knows nothing about DLMM, the database or the engine.
//!
//! **May depend on:** `binsight-core`, `binsight-solana`.
//! **Must not depend on:** `binsight-dlmm`, `binsight-ledger`, `binsight-store`, `binsight-engine`,
//! `binsight-api`.
//! (Checked in CI by `cargo xtask layering`.)
//!
//! **Start here:** [`RpcClient`], built on an [`HttpTransport`] to an [`RpcEndpoint`] with the
//! [`GovernorSettings`] of a [`HeliusPlan`], and [`WalletStream`], built on a
//! [`TungsteniteConnector`] to a [`StreamEndpoint`]. Tests of the crates above use the scripted
//! transport and connector of the `test-support` feature instead, so no test ever reaches the
//! network.

mod endpoint;
mod error;
mod governor;
mod helius_key;
mod plan;
mod rpc;
mod stream;
#[cfg(any(test, feature = "test-support"))]
pub mod test_support;
mod tls;

pub use endpoint::{RpcEndpoint, StreamEndpoint};
pub use error::{BudgetRefusal, RpcError, StreamError, TransportError};
pub use governor::{
    BilledMethod, BillingCycleDay, CreditMeter, CreditStanding, CreditUsage, GovernorSettings,
    InvalidCycleDay,
};
pub use helius_key::{HeliusApiKey, HeliusKeyError};
pub use plan::HeliusPlan;
pub use rpc::{
    ACCOUNT_BATCH_LIMIT, AccountBatch, AccountBatchError, AccountData, AccountsAtSlot, CallContext,
    DataSlice, HttpReply, HttpTransport, RawTransaction, RpcClient, RpcMethod, RpcTransport,
    SIGNATURE_PAGE_LIMIT, SendFuture, SignatureInfo, SignaturesRequest, TransactionLookup,
};
pub use stream::{
    Activity, ConnectFuture, DisconnectReason, StreamEvent, StreamSnapshot, SubscriptionStatus,
    TungsteniteConnector, WalletStream, WalletWatch, WsConnection, WsConnector, WsMessage,
    WsReceiveFuture, WsSendFuture,
};
