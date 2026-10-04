//! Where JSON-RPC requests and the WebSocket stream go, with the API key kept secret.
//!
//! Helius authenticates both by a query parameter, so a full URL is as secret as the key: it is
//! kept in a [`SecretString`] and only the HTTP transport or the WebSocket connector reads it.
//! Displaying or debugging an endpoint shows it with the key redacted. This module builds the
//! URLs; it connects to nothing.

use std::fmt;

use secrecy::{ExposeSecret, SecretString};

use crate::helius_key::HeliusApiKey;

/// The Helius mainnet JSON-RPC base URL.
const HELIUS_MAINNET_URL: &str = "https://mainnet.helius-rpc.com/";

/// A JSON-RPC endpoint whose URL holds an API key.
#[derive(Clone)]
pub struct RpcEndpoint {
    base_url: String,
    url: SecretString,
}

impl RpcEndpoint {
    /// The Helius mainnet endpoint for this key.
    pub fn helius_mainnet(key: &HeliusApiKey) -> Self {
        Self::with_base_url(HELIUS_MAINNET_URL, key)
    }

    /// An endpoint at `base_url` (which must end where the query string starts), for a local
    /// test server.
    pub fn with_base_url(base_url: &str, key: &HeliusApiKey) -> Self {
        let url = format!("{base_url}?api-key={}", key.expose_secret());
        Self {
            base_url: base_url.to_owned(),
            url: SecretString::from(url),
        }
    }

    /// The full URL, key included. Only the HTTP transport may read it, and never log it.
    pub(crate) fn expose_url(&self) -> &str {
        self.url.expose_secret()
    }
}

impl fmt::Display for RpcEndpoint {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}?api-key=[REDACTED]", self.base_url)
    }
}

impl fmt::Debug for RpcEndpoint {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "RpcEndpoint({self})")
    }
}

/// The Helius mainnet WebSocket host.
const HELIUS_MAINNET_HOST: &str = "mainnet.helius-rpc.com";

/// The port of a secure WebSocket.
const SECURE_PORT: u16 = 443;

/// The loopback address local test servers listen on.
const LOOPBACK_HOST: &str = "127.0.0.1";

/// A WebSocket endpoint whose URL holds an API key.
#[derive(Clone)]
pub struct StreamEndpoint {
    host: String,
    port: u16,
    is_secure: bool,
    url: SecretString,
}

impl StreamEndpoint {
    /// The Helius mainnet stream for this key, over TLS.
    pub fn helius_mainnet(key: &HeliusApiKey) -> Self {
        Self::new(HELIUS_MAINNET_HOST, SECURE_PORT, true, key)
    }

    /// A plain (unencrypted) stream on the loopback interface at `port`, for a local test server.
    pub fn local_plaintext(port: u16, key: &HeliusApiKey) -> Self {
        Self::new(LOOPBACK_HOST, port, false, key)
    }

    fn new(host: &str, port: u16, is_secure: bool, key: &HeliusApiKey) -> Self {
        let scheme = if is_secure { "wss" } else { "ws" };
        let url = format!("{scheme}://{host}:{port}/?api-key={}", key.expose_secret());
        Self {
            host: host.to_owned(),
            port,
            is_secure,
            url: SecretString::from(url),
        }
    }

    /// The host to connect to.
    pub(crate) fn host(&self) -> &str {
        &self.host
    }

    /// The port to connect to.
    pub(crate) const fn port(&self) -> u16 {
        self.port
    }

    /// Whether the connection goes over TLS.
    pub(crate) const fn is_secure(&self) -> bool {
        self.is_secure
    }

    /// The full URL, key included. Only the connector may read it, and never log it.
    pub(crate) fn expose_url(&self) -> &str {
        self.url.expose_secret()
    }

    /// `text` with the API key replaced, for an error message that may repeat the URL.
    pub(crate) fn redact(&self, text: &str) -> String {
        let url = self.url.expose_secret();
        let key = url.split_once("api-key=").map_or("", |(_, key)| key);
        if key.is_empty() {
            return text.to_owned();
        }
        text.replace(key, "[REDACTED]")
    }
}

impl fmt::Display for StreamEndpoint {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let scheme = if self.is_secure { "wss" } else { "ws" };
        write!(
            formatter,
            "{scheme}://{}:{}/?api-key=[REDACTED]",
            self.host, self.port
        )
    }
}

impl fmt::Debug for StreamEndpoint {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "StreamEndpoint({self})")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn never_shows_the_api_key_in_the_endpoint_display() {
        let key = HeliusApiKey::parse("super-secret-key").unwrap();
        let endpoint = RpcEndpoint::helius_mainnet(&key);

        assert_eq!(
            endpoint.to_string(),
            "https://mainnet.helius-rpc.com/?api-key=[REDACTED]"
        );
        assert!(!format!("{endpoint:?}").contains("super-secret-key"));
    }

    #[test]
    fn puts_the_key_in_the_query_string_of_the_url() {
        let key = HeliusApiKey::parse("key-1").unwrap();
        let endpoint = RpcEndpoint::with_base_url("http://127.0.0.1:9/", &key);

        assert_eq!(endpoint.expose_url(), "http://127.0.0.1:9/?api-key=key-1");
    }

    #[test]
    fn never_shows_the_api_key_in_the_stream_endpoint_display() {
        let key = HeliusApiKey::parse("super-secret-key").unwrap();
        let endpoint = StreamEndpoint::helius_mainnet(&key);

        assert_eq!(
            endpoint.to_string(),
            "wss://mainnet.helius-rpc.com:443/?api-key=[REDACTED]"
        );
        assert!(!format!("{endpoint:?}").contains("super-secret-key"));
        assert_eq!(
            endpoint.expose_url(),
            "wss://mainnet.helius-rpc.com:443/?api-key=super-secret-key"
        );
    }

    #[test]
    fn redacts_the_key_from_an_error_message() {
        let key = HeliusApiKey::parse("super-secret-key").unwrap();
        let endpoint = StreamEndpoint::local_plaintext(9, &key);

        let message = endpoint.redact("failed for ws://127.0.0.1:9/?api-key=super-secret-key");

        assert_eq!(message, "failed for ws://127.0.0.1:9/?api-key=[REDACTED]");
    }
}
