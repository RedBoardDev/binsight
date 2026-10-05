//! A stalled consumer can recover the stream's latest control state without more network traffic.

use super::*;

#[tokio::test(start_paused = true)]
async fn reconciles_a_lost_disconnect_while_waiting_without_any_wallet_or_timer() {
    let mut stream = RunningStream::start(None);
    stream.watch.watch(WALLET);
    stream
        .skip_to(|event| matches!(event, StreamEvent::Subscribed { .. }))
        .await;
    for slot in 0..1_100_u16 {
        let mut bytes = [0; 64];
        bytes[..2].copy_from_slice(&slot.to_le_bytes());
        stream
            .connector
            .notify(WALLET, Signature::from_bytes(bytes), u64::from(slot), false);
    }
    for _ in 0..16 {
        tokio::task::yield_now().await;
    }
    stream.watch.unwatch(WALLET);
    for _ in 0..16 {
        tokio::task::yield_now().await;
    }
    let snapshot = stream.rpc.stream_snapshot();
    assert!(snapshot.watched.is_empty());
    assert!(!snapshot.is_connected);
    let repaired = tokio::time::timeout(Duration::from_secs(1), async {
        loop {
            if let Some(StreamEvent::Reconciled(snapshot)) = stream.events.recv().await {
                break snapshot;
            }
        }
    })
    .await
    .expect("control facts must arrive without another network event");
    assert!(!repaired.is_connected);
    assert!(repaired.subscriptions.is_empty());
    stream.stop().await;
}
