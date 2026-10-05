//! The events of the live stream, as they travel over the wire.
//!
//! [`LiveEvent`] is a union tagged by `type`; the SSE `event:` name of each message equals that
//! `type`, so a browser can listen to each kind by name. It is registered in the contract so the
//! clients' types follow it. This module defines the wire form and converts engine events to it.

use binsight_engine::EngineEvent;
use jiff::Timestamp;
use serde::Serialize;
use utoipa::ToSchema;

use crate::contract::SyncState;
use crate::instance::health::EngineStatus;

/// A message of the live event stream.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ToSchema)]
#[serde(tag = "type", rename_all = "snake_case")]
pub(crate) enum LiveEvent {
    /// Sent every 15 seconds so clients can tell a quiet stream from a dead one.
    Heartbeat {
        /// The server's clock (RFC 3339, UTC).
        server_time: Timestamp,
    },
    /// The engine's lifecycle status: sent first on every connection, then on each change.
    EngineStatus {
        /// The new status.
        status: EngineStatus,
    },
    /// The monitor changed a tracked wallet's synchronization state.
    WalletSyncChanged {
        /// The wallet address in base58.
        wallet: String,
        /// The state decided from real ingestion facts.
        state: SyncState,
    },
}

impl LiveEvent {
    /// The SSE event name, equal to the `type` field.
    pub(crate) fn name(&self) -> &'static str {
        match self {
            Self::Heartbeat { .. } => "heartbeat",
            Self::EngineStatus { .. } => "engine_status",
            Self::WalletSyncChanged { .. } => "wallet_sync_changed",
        }
    }
}

impl LiveEvent {
    /// The wire form of an engine event.
    pub(crate) fn from_engine(event: &EngineEvent) -> Self {
        match *event {
            EngineEvent::StatusChanged { status } => Self::EngineStatus {
                status: status.into(),
            },
            EngineEvent::WalletSyncChanged { wallet, state } => Self::WalletSyncChanged {
                wallet: wallet.to_string(),
                state: state.into(),
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_the_type_tag_equal_to_the_event_name() {
        let events = [
            LiveEvent::Heartbeat {
                server_time: Timestamp::from_second(1_790_000_000).unwrap(),
            },
            LiveEvent::EngineStatus {
                status: EngineStatus::Running,
            },
            LiveEvent::from_engine(&EngineEvent::WalletSyncChanged {
                wallet: binsight_solana::Address::from_bytes([1; 32]),
                state: binsight_engine::SyncState::Lagging,
            }),
        ];
        for event in events {
            let json = serde_json::to_value(&event).unwrap();
            assert_eq!(json["type"], event.name());
        }
    }

    #[test]
    fn writes_the_heartbeat_time_in_rfc_3339() {
        let heartbeat = LiveEvent::Heartbeat {
            server_time: Timestamp::from_second(1_790_000_000).unwrap(),
        };
        assert_eq!(
            serde_json::to_string(&heartbeat).unwrap(),
            r#"{"type":"heartbeat","server_time":"2026-09-21T14:13:20Z"}"#
        );
    }
}
