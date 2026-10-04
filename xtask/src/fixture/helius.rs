//! A minimal, blocking JSON-RPC client for Helius, used only to capture fixtures.
//!
//! The API key comes from the `HELIUS_API_KEY` environment variable (the `just fixture-capture`
//! recipe reads it from `.env`). It travels in the request URL, so neither the key nor the URL is
//! ever printed: every error message has the key masked. This module sends requests and returns
//! answers; it does not decide what to keep.

use std::time::Duration;

use anyhow::{Context, bail};
use serde::Deserialize;
use serde_json::Value;
use serde_json::value::RawValue;

/// The Helius mainnet endpoint, without the key.
const ENDPOINT: &str = "https://mainnet.helius-rpc.com/";

/// The environment variable that holds the API key.
const API_KEY_VARIABLE: &str = "HELIUS_API_KEY";

/// How long one request may take, connection included.
const REQUEST_TIMEOUT_SECS: u64 = 30;

/// What replaces the API key in error messages.
const MASK: &str = "<api key>";

/// A Helius JSON-RPC client.
pub(crate) struct Helius {
    agent: ureq::Agent,
    api_key: String,
    calls: u32,
}

/// The envelope of a JSON-RPC answer; `result` is kept as the exact text the node sent.
#[derive(Deserialize)]
struct Envelope<'a> {
    #[serde(borrow, default)]
    result: Option<&'a RawValue>,
    #[serde(default)]
    error: Option<RpcError>,
}

#[derive(Deserialize)]
struct RpcError {
    code: i64,
    message: String,
}

impl Helius {
    /// A client using the key in `HELIUS_API_KEY`.
    pub(crate) fn from_environment() -> anyhow::Result<Self> {
        #[expect(
            clippy::disallowed_methods,
            reason = "xtask is tooling outside the product; its key comes from its environment"
        )]
        let api_key = std::env::var(API_KEY_VARIABLE).unwrap_or_default();
        if api_key.trim().is_empty() {
            bail!(
                "{API_KEY_VARIABLE} is not set; run `just fixture-capture`, which reads \
                 BINSIGHT_HELIUS_API_KEY from .env"
            );
        }
        Ok(Self::with_key(api_key.trim().to_owned()))
    }

    fn with_key(api_key: String) -> Self {
        let agent = ureq::Agent::config_builder()
            .timeout_global(Some(Duration::from_secs(REQUEST_TIMEOUT_SECS)))
            .http_status_as_error(false)
            .build()
            .new_agent();
        Self {
            agent,
            api_key,
            calls: 0,
        }
    }

    /// How many requests this client has sent.
    pub(crate) fn calls(&self) -> u32 {
        self.calls
    }

    /// Sends one request and returns the whole answer body, unchanged.
    pub(crate) fn call(&mut self, method: &str, params: &Value) -> anyhow::Result<String> {
        let request = serde_json::json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": method,
            "params": params,
        });
        let url = format!("{ENDPOINT}?api-key={}", self.api_key);
        self.calls = self.calls.saturating_add(1);
        let mut response = self
            .agent
            .post(&url)
            .header("content-type", "application/json")
            .send(request.to_string())
            .map_err(|error| self.masked(method, &error))?;
        let status = response.status();
        let body = response
            .body_mut()
            .read_to_string()
            .map_err(|error| self.masked(method, &error))?;
        if !status.is_success() {
            bail!("Helius answered {method} with HTTP {status}");
        }
        Ok(body)
    }

    /// Sends one request and returns the text of its `result`, exactly as the node wrote it.
    ///
    /// A JSON-RPC error or a `null` result is an error: there is nothing to capture.
    pub(crate) fn result(&mut self, method: &str, params: &Value) -> anyhow::Result<String> {
        let body = self.call(method, params)?;
        let envelope: Envelope<'_> = serde_json::from_str(&body)
            .with_context(|| format!("the answer to {method} is not JSON-RPC"))?;
        if let Some(error) = envelope.error {
            bail!(
                "{method} failed with RPC error {}: {}",
                error.code,
                self.mask(&error.message)
            );
        }
        match envelope.result {
            Some(result) if result.get() != "null" => Ok(result.get().to_owned()),
            _ => bail!("{method} returned no result (not found at this commitment)"),
        }
    }

    fn masked(&self, method: &str, error: &ureq::Error) -> anyhow::Error {
        anyhow::anyhow!(
            "the {method} request to Helius failed: {}",
            self.mask(&error.to_string())
        )
    }

    fn mask(&self, text: &str) -> String {
        text.replace(&self.api_key, MASK)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn never_shows_the_api_key_in_an_error() {
        let helius = Helius::with_key("not-a-real-key".to_owned());
        let error = ureq::Error::BadUri(format!("{ENDPOINT}?api-key=not-a-real-key"));
        let message = helius.masked("getTransaction", &error).to_string();
        assert!(!message.contains("not-a-real-key"), "{message}");
        assert!(message.contains("api-key=<api key>"), "{message}");
    }
}
