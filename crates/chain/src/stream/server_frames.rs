//! What the session does with each text frame the server sends.
//!
//! A subscription answer confirms a wallet (or releases a subscription nobody watches any more);
//! an error is reported as an event and logged, never swallowed, and a refused subscription is
//! asked again later; a notification is reported once per wallet and signature; anything else is
//! logged and ignored. This module reads; the session owns the connection.

use tokio::time::Instant;
use tracing::{debug, warn};

use super::frames::{ServerFrame, read_frame};
use super::session::release;
use super::stream_events::{Activity, DisconnectReason, StreamEvent};
use super::subscriptions::Confirmation;
use super::supervisor::Supervision;
use super::ws_connection::WsConnection;

/// Reads one text frame from the server.
pub(super) async fn read_frame_from_server(
    text: &str,
    connection: &mut dyn WsConnection,
    supervision: &mut Supervision,
) -> Result<(), DisconnectReason> {
    match read_frame(text) {
        ServerFrame::SubscriptionStarted {
            request_id,
            subscription,
        } => match supervision
            .subscriptions
            .confirmed(request_id, subscription)
        {
            Confirmation::Subscribed(wallet) => {
                debug!(%wallet, subscription, "wallet subscribed");
                supervision.outbox.send(StreamEvent::Subscribed { wallet });
                Ok(())
            }
            Confirmation::Release(subscription) => {
                release(subscription, connection, supervision).await
            }
            Confirmation::Unrelated => Ok(()),
        },
        ServerFrame::Answered { .. } => Ok(()),
        ServerFrame::Error {
            request_id,
            code,
            message,
        } => {
            report_error(request_id, code, message, supervision);
            Ok(())
        }
        ServerFrame::Notification {
            subscription,
            signature,
            slot,
            is_failed,
        } => {
            let Some(wallet) = supervision.subscriptions.wallet_of(subscription) else {
                debug!(subscription, "notification of a released subscription");
                return Ok(());
            };
            if supervision.recent.remember(wallet, signature) {
                let activity = Activity {
                    wallet,
                    signature,
                    slot,
                    is_failed,
                };
                supervision.outbox.send(StreamEvent::Activity(activity));
            }
            Ok(())
        }
        ServerFrame::Unrecognized => {
            debug!(length = text.len(), "a stream frame was not recognized");
            Ok(())
        }
    }
}

/// Reports an error frame: a refused subscription, or an error that answers nothing of ours.
fn report_error(
    request_id: Option<u64>,
    code: i64,
    message: String,
    supervision: &mut Supervision,
) {
    let now = Instant::now();
    let refused_wallet =
        request_id.and_then(|request_id| supervision.subscriptions.refused(request_id, now));
    let event = if let Some(wallet) = refused_wallet {
        warn!(%wallet, code, %message, "the stream refused a subscription; asking again later");
        StreamEvent::SubscriptionRefused {
            wallet,
            code,
            message,
        }
    } else {
        warn!(code, %message, "the stream sent an error");
        StreamEvent::ServerError { code, message }
    };
    supervision.outbox.send(event);
}
