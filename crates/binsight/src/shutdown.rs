//! Turns the operating system's stop signals into the shutdown token.
//!
//! `Ctrl-C` (SIGINT) and SIGTERM (what `docker stop` and service managers send) both start a
//! graceful shutdown. Handling SIGTERM ourselves matters in a container, where the process is
//! PID 1 and would otherwise ignore it. This module only listens; the shutdown itself is the
//! commands' job.

use tokio_util::sync::CancellationToken;
use tracing::{error, info};

/// The stop signals, listened to from the moment this value is created.
///
/// Create it before telling anyone that the server is up: a signal that arrives before its
/// handler is registered gets the default action, which kills the process without a graceful
/// shutdown.
pub struct StopSignals {
    #[cfg(unix)]
    unix: Option<UnixStopSignals>,
}

#[cfg(unix)]
struct UnixStopSignals {
    interrupt: tokio::signal::unix::Signal,
    terminate: tokio::signal::unix::Signal,
}

impl StopSignals {
    /// Starts listening for SIGINT and SIGTERM. Must be called inside the async runtime.
    pub fn listen() -> Self {
        #[cfg(unix)]
        {
            use tokio::signal::unix::{SignalKind, signal};
            let unix = match (
                signal(SignalKind::interrupt()),
                signal(SignalKind::terminate()),
            ) {
                (Ok(interrupt), Ok(terminate)) => Some(UnixStopSignals {
                    interrupt,
                    terminate,
                }),
                (Err(failure), _) | (_, Err(failure)) => {
                    error!(
                        error = %failure,
                        "cannot listen for stop signals; only Ctrl-C stops binsight"
                    );
                    None
                }
            };
            Self { unix }
        }
        #[cfg(not(unix))]
        {
            Self {}
        }
    }

    /// Waits for a stop signal, then cancels `shutdown`. Returns early if `shutdown` is
    /// cancelled for another reason.
    pub async fn cancel_on_signal(self, shutdown: CancellationToken) {
        tokio::select! {
            signal = self.next() => {
                info!(signal, "stop signal received; shutting down");
                shutdown.cancel();
            }
            () = shutdown.cancelled() => {}
        }
    }

    /// The name of the first stop signal received.
    async fn next(self) -> &'static str {
        #[cfg(unix)]
        if let Some(mut unix) = self.unix {
            return tokio::select! {
                _ = unix.interrupt.recv() => "SIGINT",
                _ = unix.terminate.recv() => "SIGTERM",
            };
        }
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
