//! Which client a login attempt comes from, for the login throttle.
//!
//! By default it is the address of the connection. Behind a reverse proxy every connection comes
//! from the proxy, so the owner can name the header the proxy writes the client's address into
//! ([`ClientIpHeader`], such as `X-Forwarded-For`); it is off by default, because a client
//! talking to binsight directly could write any address there. The last address of the header
//! is used: it is the one the trusted proxy added. IPv6 addresses count per `/64`, the block a
//! single host usually gets. This module identifies clients; it does not count anything.

use std::convert::Infallible;
use std::fmt;
use std::future::ready;
use std::net::{IpAddr, Ipv6Addr, SocketAddr};

use axum::extract::{ConnectInfo, FromRequestParts};
use axum::http::request::Parts;
use axum::http::{HeaderMap, HeaderName};

use crate::state::AppState;

/// The bits of an IPv6 address that identify one host's block (`/64`).
const IPV6_HOST_BLOCK_MASK: u128 = !0 << 64;

/// The header a trusted reverse proxy writes the client's address into.
#[derive(Clone, PartialEq, Eq)]
pub struct ClientIpHeader(HeaderName);

/// Why a text is not a usable header name.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{0:?} is not a valid HTTP header name, such as X-Forwarded-For")]
pub struct ClientIpHeaderError(String);

impl ClientIpHeader {
    /// Parses a header name, such as `X-Forwarded-For` or `X-Real-IP` (case does not matter).
    ///
    /// # Errors
    ///
    /// Returns a [`ClientIpHeaderError`] if `text` is not a valid header name.
    pub fn parse(text: &str) -> Result<Self, ClientIpHeaderError> {
        HeaderName::try_from(text.trim())
            .map(Self)
            .map_err(|_| ClientIpHeaderError(text.to_owned()))
    }

    /// The last address in this header of `headers`, if there is a valid one.
    fn last_address_in(&self, headers: &HeaderMap) -> Option<IpAddr> {
        let value = headers.get_all(&self.0).iter().next_back()?.to_str().ok()?;
        parse_address(value.rsplit(',').next()?.trim())
    }
}

impl fmt::Debug for ClientIpHeader {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "ClientIpHeader({})", self.0)
    }
}

impl fmt::Display for ClientIpHeader {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.0.as_str())
    }
}

/// A client, as the login throttle counts it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub(crate) enum ClientKey {
    /// An IPv4 address, or the `/64` block of an IPv6 address.
    Address(IpAddr),
    /// No address is known (only in tests, which call the router without a connection).
    Unknown,
}

impl ClientKey {
    /// The key of `address`: IPv6 addresses are reduced to their `/64` block, and an
    /// IPv4-mapped IPv6 address is its IPv4 address.
    pub(crate) fn of(address: IpAddr) -> Self {
        Self::Address(match address {
            IpAddr::V6(v6) => match v6.to_ipv4_mapped() {
                Some(v4) => IpAddr::V4(v4),
                None => IpAddr::V6(Ipv6Addr::from_bits(v6.to_bits() & IPV6_HOST_BLOCK_MASK)),
            },
            IpAddr::V4(_) => address,
        })
    }
}

/// The extractor: the client of the request.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct RequestClient(pub(crate) ClientKey);

impl FromRequestParts<AppState> for RequestClient {
    type Rejection = Infallible;

    fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> impl Future<Output = Result<Self, Self::Rejection>> + Send {
        let forwarded = state
            .auth
            .client_ip_header
            .as_ref()
            .and_then(|header| header.last_address_in(&parts.headers));
        let connection = parts
            .extensions
            .get::<ConnectInfo<SocketAddr>>()
            .map(|ConnectInfo(address)| address.ip());
        let client = forwarded
            .or(connection)
            .map_or(ClientKey::Unknown, ClientKey::of);
        ready(Ok(Self(client)))
    }
}

/// An address as proxies write it: `192.0.2.1`, `2001:db8::1`, or with a port.
fn parse_address(text: &str) -> Option<IpAddr> {
    text.parse::<IpAddr>()
        .ok()
        .or_else(|| text.parse::<SocketAddr>().ok().map(|socket| socket.ip()))
}

#[cfg(test)]
mod tests {
    use axum::http::HeaderValue;

    use super::*;

    fn headers(pairs: &[(&'static str, &'static str)]) -> HeaderMap {
        let mut headers = HeaderMap::new();
        for (name, value) in pairs {
            headers.append(*name, HeaderValue::from_static(value));
        }
        headers
    }

    fn address(text: &str) -> IpAddr {
        text.parse().unwrap()
    }

    #[test]
    fn reads_the_last_address_of_the_header() {
        let header = ClientIpHeader::parse("X-Forwarded-For").unwrap();

        let found = header.last_address_in(&headers(&[
            ("x-forwarded-for", "10.0.0.1"),
            ("x-forwarded-for", "198.51.100.1, 203.0.113.9"),
        ]));

        assert_eq!(found, Some(address("203.0.113.9")));
    }

    #[test]
    fn accepts_an_address_with_a_port() {
        let header = ClientIpHeader::parse("x-real-ip").unwrap();

        assert_eq!(
            header.last_address_in(&headers(&[("x-real-ip", "[2001:db8::7]:4431")])),
            Some(address("2001:db8::7"))
        );
        assert_eq!(
            header.last_address_in(&headers(&[("x-real-ip", "not an address")])),
            None
        );
    }

    #[test]
    fn counts_an_ipv6_host_by_its_64_bit_block() {
        assert_eq!(
            ClientKey::of(address("2001:db8:1:2:aaaa::1")),
            ClientKey::of(address("2001:db8:1:2:bbbb::9"))
        );
        assert_ne!(
            ClientKey::of(address("2001:db8:1:2::1")),
            ClientKey::of(address("2001:db8:1:3::1"))
        );
    }

    #[test]
    fn counts_an_ipv4_mapped_address_as_ipv4() {
        assert_eq!(
            ClientKey::of(address("::ffff:192.0.2.1")),
            ClientKey::of(address("192.0.2.1"))
        );
    }

    #[test]
    fn refuses_a_text_that_is_not_a_header_name() {
        assert!(ClientIpHeader::parse("X Forwarded For").is_err());
        assert_eq!(
            ClientIpHeader::parse(" X-Real-IP ").unwrap().to_string(),
            "x-real-ip"
        );
    }
}
