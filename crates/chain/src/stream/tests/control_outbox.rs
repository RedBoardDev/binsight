//! Lost control transitions are recoverable from the retained snapshot.

use super::*;
use crate::stream::{Activity, SubscriptionStatus};
use binsight_solana::{Address, Signature};

#[tokio::test]
async fn reconciles_control_transitions_lost_behind_more_than_a_channel_of_activity() {
    let (sender, mut events) = mpsc::channel(1_024);
    let clock = Arc::new(binsight_core::clock::FixedClock::new(
        "2026-10-05T00:00:00Z".parse().unwrap(),
    ));
    let rpc = crate::test_support::scripted_client(
        crate::test_support::ScriptedTransport::new(),
        clock,
        None,
    );
    let mut outbox = EventOutbox::new(sender, rpc);
    let first = Address::from_bytes([1; 32]);
    let second = Address::from_bytes([2; 32]);
    outbox.send(StreamEvent::Connected);
    outbox.send(StreamEvent::Subscribed { wallet: first });
    for slot in 0..1_100 {
        outbox.send(StreamEvent::Activity(Activity {
            wallet: first,
            signature: Signature::from_bytes([1; 64]),
            slot,
            is_failed: false,
        }));
    }
    outbox.send(StreamEvent::Disconnected {
        reason: DisconnectReason::Unanswered,
    });
    outbox.send(StreamEvent::Connected);
    outbox.send(StreamEvent::SubscriptionRefused {
        wallet: first,
        code: -32_600,
        message: "unavailable".to_owned(),
    });
    outbox.send(StreamEvent::Subscribed { wallet: second });
    while events.try_recv().is_ok() {}
    outbox.flush_overflow();
    assert_eq!(events.recv().await, Some(StreamEvent::Overflowed));
    outbox.flush_overflow();
    let Some(StreamEvent::Reconciled(snapshot)) = events.recv().await else {
        panic!("control snapshot required after overflow");
    };
    assert!(snapshot.is_connected);
    assert!(matches!(
        snapshot.subscriptions.get(&first),
        Some(SubscriptionStatus::Refused { .. })
    ));
    assert_eq!(
        snapshot.subscriptions.get(&second),
        Some(&SubscriptionStatus::Subscribed)
    );
}
