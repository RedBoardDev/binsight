//! The address the owner opens binsight at, when it is not the address the server listens on.
//!
//! Behind a reverse proxy (`https://binsight.example.com`), browsers send that origin with their
//! requests: it is trusted by the cross-site request protection, and when it is `https` the
//! session cookie is marked `Secure`. This module parses the setting; it does not apply it.

use std::fmt;

use tower_http::csrf::CsrfLayer;

/// A validated public URL: `http://` or `https://`, a host, an optional port, and no path.
#[derive(Clone)]
pub struct PublicUrl {
    origin: String,
    is_https: bool,
    cross_site_protection: CsrfLayer,
}

/// Why a text is not a usable public URL.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum PublicUrlError {
    /// The URL does not start with `http://` or `https://`.
    #[error("the public URL must start with http:// or https://")]
    UnsupportedScheme,
    /// The URL has a path, a query or a fragment, or no host.
    #[error(
        "the public URL must be just a scheme, a host and an optional port, like https://binsight.example.com"
    )]
    NotAnOrigin,
}

impl PublicUrl {
    /// Parses `text`; a single trailing `/` is accepted and dropped.
    ///
    /// # Errors
    ///
    /// Returns a [`PublicUrlError`] if the text is not an `http` or `https` origin.
    pub fn parse(text: &str) -> Result<Self, PublicUrlError> {
        let (is_https, rest) = if let Some(rest) = text.strip_prefix("https://") {
            (true, rest)
        } else if let Some(rest) = text.strip_prefix("http://") {
            (false, rest)
        } else {
            return Err(PublicUrlError::UnsupportedScheme);
        };
        let authority = rest.strip_suffix('/').unwrap_or(rest);
        let origin = text.strip_suffix('/').unwrap_or(text);
        let has_extra_parts = authority.contains(['/', '?', '#', '@', ' ']);
        if authority.is_empty() || has_extra_parts {
            return Err(PublicUrlError::NotAnOrigin);
        }
        let cross_site_protection = CsrfLayer::new()
            .add_trusted_origin(origin)
            .map_err(|_| PublicUrlError::NotAnOrigin)?;
        Ok(Self {
            origin: origin.to_owned(),
            is_https,
            cross_site_protection,
        })
    }

    /// Whether the owner reaches binsight over HTTPS.
    pub(crate) fn is_https(&self) -> bool {
        self.is_https
    }

    /// The cross-site request protection that trusts this origin.
    pub(crate) fn cross_site_protection(&self) -> CsrfLayer {
        self.cross_site_protection.clone()
    }
}

impl fmt::Debug for PublicUrl {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "PublicUrl({})", self.origin)
    }
}

impl fmt::Display for PublicUrl {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.origin)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_an_https_origin_with_or_without_a_port() {
        let url = PublicUrl::parse("https://binsight.example.com/").unwrap();
        assert!(url.is_https());
        assert_eq!(url.to_string(), "https://binsight.example.com");

        let local = PublicUrl::parse("http://192.168.1.20:8080").unwrap();
        assert!(!local.is_https());
    }

    #[test]
    fn refuses_anything_that_is_not_an_http_origin() {
        for text in [
            "binsight.example.com",
            "ftp://example.com",
            "wss://example.com",
        ] {
            assert_eq!(
                PublicUrl::parse(text).unwrap_err(),
                PublicUrlError::UnsupportedScheme
            );
        }
        for text in [
            "https://",
            "https://example.com/app",
            "https://example.com?x=1",
            "https://user@example.com",
        ] {
            assert_eq!(
                PublicUrl::parse(text).unwrap_err(),
                PublicUrlError::NotAnOrigin,
                "{text}"
            );
        }
    }
}
