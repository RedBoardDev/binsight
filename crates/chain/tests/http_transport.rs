//! The HTTP transport against a local server speaking raw HTTP/1.1: no Internet involved.

#![allow(clippy::unwrap_used, clippy::expect_used, reason = "tests fail loudly")]

use std::time::Duration;

use binsight_chain::{HeliusApiKey, HttpTransport, RpcEndpoint, RpcTransport, TransportError};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

const KEY: &str = "secret-test-key-123";

/// Serves one request with `response` and returns the raw request it received.
async fn serve_once(response: &'static str) -> (String, tokio::task::JoinHandle<String>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base_url = format!("http://{}/", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut request = Vec::new();
        let mut buffer = [0_u8; 4096];
        while !request_is_complete(&request) {
            let read = socket.read(&mut buffer).await.unwrap();
            assert_ne!(read, 0, "the client closed the connection early");
            request.extend_from_slice(buffer.get(..read).unwrap());
        }
        socket.write_all(response.as_bytes()).await.unwrap();
        socket.shutdown().await.unwrap();
        String::from_utf8(request).unwrap()
    });
    (base_url, server)
}

/// Whether the headers and the whole `Content-Length` body have arrived.
fn request_is_complete(request: &[u8]) -> bool {
    let text = String::from_utf8_lossy(request);
    let Some((headers, body)) = text.split_once("\r\n\r\n") else {
        return false;
    };
    let length = headers
        .lines()
        .find_map(|line| {
            line.to_lowercase()
                .strip_prefix("content-length:")
                .map(str::to_owned)
        })
        .map_or(0, |value| value.trim().parse::<usize>().unwrap());
    body.len() >= length
}

fn transport(base_url: &str) -> HttpTransport {
    let key = HeliusApiKey::parse(KEY).unwrap();
    HttpTransport::new(RpcEndpoint::with_base_url(base_url, &key)).unwrap()
}

#[tokio::test]
async fn posts_the_json_body_with_the_key_in_the_query_string() {
    let (base_url, server) = serve_once(
        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 11\r\n\
         Connection: close\r\n\r\n{\"ok\":true}",
    )
    .await;

    let reply = transport(&base_url)
        .send(b"{\"method\":\"getHealth\"}".to_vec())
        .await
        .unwrap();

    let request = server.await.unwrap();
    assert!(
        request.starts_with(&format!("POST /?api-key={KEY} HTTP/1.1")),
        "{request}"
    );
    assert!(
        request
            .to_lowercase()
            .contains("content-type: application/json")
    );
    assert!(request.to_lowercase().contains("user-agent: binsight/"));
    assert!(request.ends_with("{\"method\":\"getHealth\"}"));
    assert_eq!(reply.status, 200);
    assert_eq!(reply.body, b"{\"ok\":true}");
}

#[tokio::test]
async fn reads_the_status_and_the_retry_after_of_a_refusal() {
    let (base_url, server) = serve_once(
        "HTTP/1.1 429 Too Many Requests\r\nRetry-After: 2\r\nContent-Length: 4\r\n\
         Connection: close\r\n\r\nslow",
    )
    .await;

    let reply = transport(&base_url).send(b"{}".to_vec()).await.unwrap();

    server.await.unwrap();
    assert_eq!(reply.status, 429);
    assert_eq!(reply.retry_after, Some(Duration::from_secs(2)));
    assert_eq!(reply.body, b"slow");
}

#[tokio::test]
async fn returns_a_redirect_instead_of_following_it() {
    let (base_url, server) = serve_once(
        "HTTP/1.1 301 Moved Permanently\r\nLocation: http://127.0.0.1:9/elsewhere\r\n\
         Content-Length: 0\r\nConnection: close\r\n\r\n",
    )
    .await;

    let reply = transport(&base_url).send(b"{}".to_vec()).await.unwrap();

    server.await.unwrap();
    assert_eq!(reply.status, 301);
}

#[tokio::test]
async fn never_shows_the_api_key_in_a_transport_error() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base_url = format!("http://{}/", listener.local_addr().unwrap());
    drop(listener);

    let error = transport(&base_url).send(b"{}".to_vec()).await.unwrap_err();

    assert!(matches!(error, TransportError::Connect { .. }), "{error:?}");
    assert!(!error.to_string().contains(KEY), "{error}");
    assert!(!format!("{error:?}").contains(KEY), "{error:?}");
}
