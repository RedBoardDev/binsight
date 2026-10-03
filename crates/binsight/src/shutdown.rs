//! Turns the operating system's stop signals into the shutdown token.
//!
//! `Ctrl-C` (SIGINT) and SIGTERM (what `docker stop` and service managers send) both start a
//! graceful shutdown. Handling SIGTERM ourselves matters in a container, where the process is
//! PID 1 and would otherwise ignore it. This module only listens; the shutdown itself is the
//! commands' job.

use tokio_util::sync::CancellationToken;
use tracing::{error, info};

/// Waits for SIGINT or SIGTERM, then cancels `shutdown`. Returns early if `shutdown` is
/// cancelled for another reason.
pub async fn cancel_on_signal(shutdown: CancellationToken) {
    tokio::select! {
        signal = stop_signal() => {
            info!(signal, "stop signal received; shutting down");
            shutdown.cancel();
        }
        () = shutdown.cancelled() => {}
    }
}

/// The name of the first stop signal received.
async fn stop_signal() -> &'static str {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{SignalKind, signal};
        match signal(SignalKind::terminate()) {
            Ok(mut terminate) => tokio::select! {
                _ = tokio::signal::ctrl_c() => "SIGINT",
                _ = terminate.recv() => "SIGTERM",
            },
            Err(failure) => {
                error!(error = %failure, "cannot listen for SIGTERM; only Ctrl-C stops binsight");
                interrupt().await
            }
        }
    }
    #[cfg(not(unix))]
    {
        interrupt().await
    }
}

/// Waits for Ctrl-C. If even that cannot be listened to, never returns (the process can still be
/// killed).
async fn interrupt() -> &'static str {
    if let Err(failure) = tokio::signal::ctrl_c().await {
        error!(error = %failure, "cannot listen for Ctrl-C");
        std::future::pending::<()>().await;
    }
    "SIGINT"
}
