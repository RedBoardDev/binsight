//! `binsight healthcheck` (hidden): asks the local server for `GET /api/v1/health`.
//!
//! Container images without a shell or `curl` run this as their health check: exit code 0 means
//! the server answered `200`. It connects to the configured port on the loopback address (or on
//! the configured address when it is a specific one) and speaks just enough HTTP/1.1 for that,
//! with a deadline. This module does nothing else.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::path::Path;
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

use super::block_on;
use crate::config;
use crate::failure::Failure;

/// The whole check must finish within this time.
const DEADLINE_SECS: u64 = 5;

/// The health request; `Connection: close` lets the answer end with the connection.
const REQUEST: &[u8] =
    b"GET /api/v1/health HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n";

/// Checks the health of the local server.
pub(super) fn execute(config_file: Option<&Path>) -> Result<(), Failure> {
    let config = config::load(config_file)?.config;
    let target = local_target(config.bind);
    block_on(async move {
        tokio::time::timeout(Duration::from_secs(DEADLINE_SECS), check(target))
            .await
            .map_err(|_| {
                Failure::Unhealthy(format!("no answer from {target} within {DEADLINE_SECS} s"))
            })?
    })
}

/// Where to reach a server listening on `bind`: a wildcard address means "every interface", so
/// the loopback address of the same family is used.
fn local_target(bind: SocketAddr) -> SocketAddr {
    let ip = match bind.ip() {
        IpAddr::V4(ip) if ip.is_unspecified() => IpAddr::V4(Ipv4Addr::LOCALHOST),
        IpAddr::V6(ip) if ip.is_unspecified() => IpAddr::V6(Ipv6Addr::LOCALHOST),
        ip => ip,
    };
    SocketAddr::new(ip, bind.port())
}

async fn check(target: SocketAddr) -> Result<(), Failure> {
    let mut connection = TcpStream::connect(target)
        .await
        .map_err(|error| Failure::io(format!("connect to {target}"), error))?;
    connection
        .write_all(REQUEST)
        .await
        .map_err(|error| Failure::io("send the health request", error))?;
    let mut answer = Vec::new();
    connection
        .read_to_end(&mut answer)
        .await
        .map_err(|error| Failure::io("read the health answer", error))?;
    let status_line = String::from_utf8_lossy(&answer)
        .lines()
        .next()
        .unwrap_or_default()
        .to_owned();
    if status_line.starts_with("HTTP/1.1 200 ") {
        Ok(())
    } else {
        Err(Failure::Unhealthy(format!(
            "the server answered {status_line:?}"
        )))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reaches_a_wildcard_address_through_the_loopback() {
        let target = local_target("0.0.0.0:8080".parse().unwrap());
        assert_eq!(target, "127.0.0.1:8080".parse().unwrap());
        let target = local_target("[::]:8080".parse().unwrap());
        assert_eq!(target, "[::1]:8080".parse().unwrap());
        let target = local_target("192.168.1.20:9000".parse().unwrap());
        assert_eq!(target, "192.168.1.20:9000".parse().unwrap());
    }
}
