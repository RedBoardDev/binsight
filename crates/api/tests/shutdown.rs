//! A real server on a real socket shuts down quickly even with a live stream open.
//!
//! The only test that uses the network (the loopback interface): graceful shutdown waits for open
//! connections, and an event stream never ends by itself, so this proves the streams end on the
//! shutdown signal.

#![allow(clippy::unwrap_used, clippy::expect_used, reason = "tests fail loudly")]

mod common;

use std::time::Duration;

use binsight_api::serve;
use common::TestApp;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

/// The longest acceptable shutdown with a client still connected.
const SHUTDOWN_DEADLINE_SECS: u64 = 2;

#[tokio::test]
async fn stops_within_two_seconds_with_a_live_stream_open() {
    let app = TestApp::new().await;
    let cookie = app.session_cookie().await;
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(serve(listener, app.router.clone(), app.shutdown.clone()));

    let mut client = TcpStream::connect(address).await.unwrap();
    let request =
        format!("GET /api/v1/events HTTP/1.1\r\nhost: {address}\r\ncookie: {cookie}\r\n\r\n");
    client.write_all(request.as_bytes()).await.unwrap();
    let mut received = Vec::new();
    while !String::from_utf8_lossy(&received).contains("event: engine_status") {
        let mut buffer = [0_u8; 1024];
        let read = client.read(&mut buffer).await.unwrap();
        assert_ne!(read, 0, "the server closed the stream early");
        received.extend_from_slice(buffer.get(..read).unwrap());
    }

    app.shutdown.cancel();
    let stopped = tokio::time::timeout(Duration::from_secs(SHUTDOWN_DEADLINE_SECS), server).await;

    assert!(stopped.is_ok(), "the server did not stop in time");
    stopped.unwrap().unwrap().unwrap();
}
