//! The real WebSocket connector against a local server on the loopback interface: no Internet,
//! but a real TCP connection and a real WebSocket handshake.
#![allow(clippy::unwrap_used, reason = "tests fail loudly")]

use std::time::Duration;

use binsight_chain::{HeliusApiKey, StreamEndpoint, TungsteniteConnector, WsConnector, WsMessage};
use futures_util::{SinkExt, StreamExt};
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::Message;

/// How long any step of these tests may take.
const PATIENCE: Duration = Duration::from_secs(10);

async fn local_server() -> (TcpListener, StreamEndpoint) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let key = HeliusApiKey::parse("loopback-secret-key").unwrap();
    (listener, StreamEndpoint::local_plaintext(port, &key))
}

#[tokio::test]
async fn exchanges_frames_with_a_websocket_server_and_sees_it_close() {
    let (listener, endpoint) = local_server().await;
    let server = tokio::spawn(async move {
        let (tcp, _) = listener.accept().await.unwrap();
        let mut socket = tokio_tungstenite::accept_async(tcp).await.unwrap();
        let request = socket.next().await.unwrap().unwrap();
        socket
            .send(Message::text(format!("echo {request}")))
            .await
            .unwrap();
        socket.send(Message::Ping(vec![1, 2].into())).await.unwrap();
        socket.close(None).await.unwrap();
    });
    let connector = TungsteniteConnector::new(endpoint).unwrap();

    let mut connection = tokio::time::timeout(PATIENCE, connector.connect())
        .await
        .unwrap()
        .unwrap();
    connection
        .send(WsMessage::Text("hello".to_owned()))
        .await
        .unwrap();
    let mut received = Vec::new();
    while let Some(message) = tokio::time::timeout(PATIENCE, connection.receive())
        .await
        .unwrap()
    {
        match message.unwrap() {
            WsMessage::Close => break,
            other => received.push(other),
        }
    }

    assert_eq!(
        received,
        [
            WsMessage::Text("echo hello".to_owned()),
            WsMessage::Ping(vec![1, 2])
        ]
    );
    server.await.unwrap();
}

#[tokio::test]
async fn never_shows_the_api_key_when_the_stream_cannot_be_opened() {
    let (listener, endpoint) = local_server().await;
    let server = tokio::spawn(async move {
        let (tcp, _) = listener.accept().await.unwrap();
        drop(tcp);
    });
    let connector = TungsteniteConnector::new(endpoint).unwrap();

    let refused = tokio::time::timeout(PATIENCE, connector.connect())
        .await
        .unwrap()
        .err()
        .unwrap();

    assert!(
        !refused.to_string().contains("loopback-secret-key"),
        "{refused}"
    );
    server.await.unwrap();
}
