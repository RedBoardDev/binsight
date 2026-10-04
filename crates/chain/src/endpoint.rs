//! Where JSON-RPC requests are sent, with the API key kept secret.
//!
//! Helius authenticates by a query parameter, so the full URL is as secret as the key: it is
//! kept in a [`SecretString`] and only the HTTP transport reads it. Displaying or debugging an
//! endpoint shows the base URL with the key redacted. This module builds the URL; it sends
//! nothing.

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
}
