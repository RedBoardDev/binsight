//! Serves the router on a listening socket until shutdown.
//!
//! On shutdown the server stops accepting connections and waits for the requests in flight;
//! long-lived responses (the live event streams) end themselves on the same signal. Bounding the
//! total wait is the caller's job. This module does not build routes.

use std::io;

use axum::Router;
use tokio::net::TcpListener;
use tokio_util::sync::CancellationToken;

/// Serves `router` on `listener` until `shutdown` is cancelled and the open requests finish.
///
/// # Errors
///
/// Returns the I/O error that stopped the server.
pub async fn serve(
    listener: TcpListener,
    router: Router,
    shutdown: CancellationToken,
) -> io::Result<()> {
    axum::serve(listener, router)
        .with_graceful_shutdown(shutdown.cancelled_owned())
        .await
}
