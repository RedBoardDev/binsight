//! The real transport: JSON-RPC over HTTPS with `reqwest` and `rustls`.
//!
//! TLS uses the `ring` provider and the Mozilla root certificates compiled into the binary, so it
//! needs no system certificate bundle and no OpenSSL. The HTTP library puts the request URL, and
//! so the API key, in its error messages: every error is stripped of its URL before it leaves this
//! module. Redirects are never followed: a followed POST turns into a GET whose answer cannot be
//! read, while the redirect status itself tells what happened. The transport sends and receives;
//! deadlines and retries belong to the client.

use std::sync::Arc;
use std::time::Duration;

use reqwest::header::{CONTENT_TYPE, RETRY_AFTER};

use crate::endpoint::RpcEndpoint;
use crate::error::TransportError;
use crate::rpc::transport::{HttpReply, RpcTransport, SendFuture};

/// How long opening a connection (TCP and TLS) may take.
const CONNECT_TIMEOUT_SECS: u64 = 5;

/// How long an idle connection is kept for the next request.
const IDLE_CONNECTION_TIMEOUT_SECS: u64 = 60;

/// The `User-Agent` header of every request.
const USER_AGENT: &str = concat!("binsight/", env!("CARGO_PKG_VERSION"));

/// Sends JSON-RPC requests to one endpoint over HTTPS.
#[derive(Debug, Clone)]
pub struct HttpTransport {
    client: reqwest::Client,
    endpoint: RpcEndpoint,
}

impl HttpTransport {
    /// A transport to `endpoint`. Nothing is sent until the first request.
    ///
    /// # Errors
    ///
    /// Returns [`TransportError::Connect`] if the TLS configuration or the HTTP client cannot be
    /// built.
    pub fn new(endpoint: RpcEndpoint) -> Result<Self, TransportError> {
        let client = reqwest::Client::builder()
            .tls_backend_preconfigured(tls_config()?)
            .connect_timeout(Duration::from_secs(CONNECT_TIMEOUT_SECS))
            .pool_idle_timeout(Duration::from_secs(IDLE_CONNECTION_TIMEOUT_SECS))
            .user_agent(USER_AGENT)
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|error| TransportError::Connect {
                detail: error.without_url().to_string(),
            })?;
        Ok(Self { client, endpoint })
    }

    async fn post(&self, body: Vec<u8>) -> Result<HttpReply, TransportError> {
        let response = self
            .client
            .post(self.endpoint.expose_url())
            .header(CONTENT_TYPE, "application/json")
            .body(body)
            .send()
            .await
            .map_err(transport_error)?;
        let status = response.status().as_u16();
        let retry_after = response
            .headers()
            .get(RETRY_AFTER)
            .and_then(|value| value.to_str().ok())
            .and_then(|text| text.trim().parse::<u64>().ok())
            .map(Duration::from_secs);
        let body = response.bytes().await.map_err(transport_error)?.to_vec();
        Ok(HttpReply {
            status,
            retry_after,
            body,
        })
    }
}

impl RpcTransport for HttpTransport {
    fn send(&self, body: Vec<u8>) -> SendFuture<'_> {
        Box::pin(self.post(body))
    }
}

/// TLS 1.2 and 1.3 with the `ring` provider and the embedded Mozilla roots.
fn tls_config() -> Result<rustls::ClientConfig, TransportError> {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let roots = rustls::RootCertStore {
        roots: webpki_roots::TLS_SERVER_ROOTS.to_vec(),
    };
    let config = rustls::ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .map_err(|error| TransportError::Connect {
            detail: error.to_string(),
        })?
        .with_root_certificates(roots)
        .with_no_client_auth();
    Ok(config)
}

/// Converts a `reqwest` error, dropping the URL (and so the key) from it. The causes are kept:
/// they say what went wrong (refused, reset, certificate) and never repeat the query string.
fn transport_error(error: reqwest::Error) -> TransportError {
    let is_connect = error.is_connect();
    let error = error.without_url();
    let mut detail = error.to_string();
    let mut cause = std::error::Error::source(&error);
    while let Some(inner) = cause {
        detail.push_str(": ");
        detail.push_str(&inner.to_string());
        cause = inner.source();
    }
    if is_connect {
        TransportError::Connect { detail }
    } else {
        TransportError::Request { detail }
    }
}
