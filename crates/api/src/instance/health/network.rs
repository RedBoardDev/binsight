//! RPC and stream health as observed by the engine, without network probes.

use serde::Serialize;
use utoipa::ToSchema;

/// The latest completed RPC attempt; health requests never probe the provider.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub(crate) enum RpcStatus {
    /// The configured RPC transport has not completed an attempt yet.
    Unknown,
    /// The latest request succeeded.
    Ok,
    /// The latest request failed or was refused.
    Unavailable,
}

impl From<binsight_engine::RpcHealth> for RpcStatus {
    fn from(health: binsight_engine::RpcHealth) -> Self {
        match health {
            binsight_engine::RpcHealth::Unknown => Self::Unknown,
            binsight_engine::RpcHealth::Ok => Self::Ok,
            binsight_engine::RpcHealth::Unavailable => Self::Unavailable,
        }
    }
}

/// The stream's actual connection and subscription state.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub(crate) enum StreamStatus {
    /// No wallet needs a connection.
    Idle,
    /// Waiting for the connection or its first acknowledgements.
    Connecting,
    /// All watched wallets are subscribed on an open connection.
    Connected,
    /// A connection or subscription failed or was refused.
    Unavailable,
}

impl From<binsight_engine::StreamHealth> for StreamStatus {
    fn from(health: binsight_engine::StreamHealth) -> Self {
        match health {
            binsight_engine::StreamHealth::Idle => Self::Idle,
            binsight_engine::StreamHealth::Connecting => Self::Connecting,
            binsight_engine::StreamHealth::Connected => Self::Connected,
            binsight_engine::StreamHealth::Unavailable => Self::Unavailable,
        }
    }
}
