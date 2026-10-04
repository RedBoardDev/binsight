//! The TLS client configuration every connection to the provider uses.
//!
//! TLS 1.2 and 1.3 with the `ring` provider and the Mozilla root certificates compiled into the
//! binary, so binsight needs no system certificate bundle and no OpenSSL. The HTTP transport and
//! the WebSocket stream share it; this module only builds it.

use std::sync::Arc;

/// The client configuration for TLS connections to the provider.
pub(crate) fn client_config() -> Result<rustls::ClientConfig, rustls::Error> {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let roots = rustls::RootCertStore {
        roots: webpki_roots::TLS_SERVER_ROOTS.to_vec(),
    };
    let config = rustls::ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()?
        .with_root_certificates(roots)
        .with_no_client_auth();
    Ok(config)
}
