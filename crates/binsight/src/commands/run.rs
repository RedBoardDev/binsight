//! `binsight run`: the server.
//!
//! In order: validate the configuration (nothing starts if it is invalid), start logging, handle
//! the stop signals, lock the data folder, open and upgrade the database (backing it up first),
//! create the instance secrets, listen, then run the engine and the HTTP server until a stop
//! signal. Shutdown is graceful but bounded: after [`SHUTDOWN_DEADLINE_SECS`] seconds whatever is
//! left is dropped.

use std::net::SocketAddr;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use binsight_api::auth::AuthSettings;
use binsight_api::{AppState, AppStateParts, router};
use binsight_chain::{
    GovernorSettings, HttpTransport, RpcClient, RpcEndpoint, StreamEndpoint, TungsteniteConnector,
    WsConnector,
};
use binsight_core::clock::Clock;
use binsight_engine::{Engine, SystemClock};
use binsight_store::{BackupOptions, Store, UpgradeOptions};
use tokio::net::TcpListener;
use tokio_util::sync::CancellationToken;
use tracing::{info, warn};

use super::VERSION;
use crate::config::{self, Config};
use crate::data_dir::LockedDataDir;
use crate::failure::Failure;
use crate::instance_secrets::ensure_instance_secrets;
use crate::logging;
use crate::shutdown::StopSignals;
use crate::web_assets::EmbeddedWebApp;

/// The longest graceful shutdown before the remaining work is dropped.
const SHUTDOWN_DEADLINE_SECS: u64 = 10;

/// Validates the configuration, starts logging and runs the server until it stops.
pub(super) fn execute(config_file: Option<&Path>) -> Result<(), Failure> {
    let loaded = config::load(config_file)?;
    logging::init(&loaded.config.log).map_err(|error| Failure::Unexpected(error.into()))?;
    for warning in &loaded.warnings {
        warn!(%warning, "configuration warning");
    }
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .map_err(|error| Failure::io("start the async runtime", error))?;
    runtime.block_on(serve(loaded.config))
}

async fn serve(config: Config) -> Result<(), Failure> {
    info!(
        version = VERSION,
        data_dir = %config.data_dir.display(),
        bind = %config.bind,
        config_file = config.config_file.as_ref().map(|path| path.display().to_string()),
        "binsight starting"
    );
    if !EmbeddedWebApp.is_built() {
        warn!("this binary was built without the web app; it serves a placeholder page");
    }
    // Stop signals are handled from the start: one that arrives during the backup or the
    // migrations lets them finish (the default action would kill the process halfway through a
    // copy) and stops the server as soon as it is up.
    let shutdown = CancellationToken::new();
    tokio::spawn(StopSignals::listen().cancel_on_signal(shutdown.clone()));
    let data_dir = LockedDataDir::open(&config.data_dir)?;
    let clock: Arc<dyn Clock> = Arc::new(SystemClock);
    let store = open_store(&data_dir, clock.as_ref()).await?;
    let session_secret = ensure_instance_secrets(&store).await?;
    let listener = listen(config.bind).await?;
    let rpc = rpc_client(&config, clock.clone())?;
    let stream = stream_connector(&config)?;
    let (engine, handle) = Engine::new(store.clone(), rpc, stream, clock.clone());
    let state = AppState::new(AppStateParts {
        engine: handle,
        auth: AuthSettings {
            password: config.password,
            session_secret,
            public_url: config.public_url,
            client_ip_header: config.client_ip_header,
        },
        clock,
        shutdown: shutdown.clone(),
        web_assets: Arc::new(EmbeddedWebApp),
    });
    let outcome = supervise(engine, state, listener, shutdown).await;
    if let Err(error) = store.checkpoint().await {
        warn!(%error, "could not checkpoint the database at shutdown");
    }
    info!("shutdown complete");
    outcome
}

/// Opens the database of `data_dir`, creating it or upgrading it first (after a backup).
pub(in crate::commands) async fn open_store(
    data_dir: &LockedDataDir,
    clock: &dyn Clock,
) -> Result<Store, Failure> {
    let options = UpgradeOptions {
        binary_version: VERSION.to_owned(),
        now: clock.now(),
        backups: BackupOptions {
            folder: data_dir.backups_path(),
            keep: BackupOptions::DEFAULT_KEEP,
        },
    };
    let (store, report) = Store::open_and_upgrade(&data_dir.database_path(), options).await?;
    info!(schema_version = report.to_version, "database ready");
    Ok(store)
}

/// The Helius client. Nothing is sent until the engine has a wallet to ingest.
fn rpc_client(config: &Config, clock: Arc<dyn Clock>) -> Result<RpcClient, Failure> {
    let endpoint = RpcEndpoint::helius_mainnet(&config.helius_api_key);
    let transport = HttpTransport::new(endpoint).map_err(|error| {
        Failure::Unexpected(anyhow::Error::new(error).context("prepare the RPC client"))
    })?;
    let budget = config.credit_budget;
    info!(
        plan = %budget.plan,
        monthly_credits = budget.monthly_credits.0,
        cycle_day = budget.cycle_day.get(),
        daily_credit_limit = budget.daily_credit_limit.map(|limit| limit.0),
        "rpc credit budget"
    );
    let governor = GovernorSettings {
        requests_per_second: budget.plan.requests_per_second(),
        cycle_credits: budget.monthly_credits,
        cycle_day: budget.cycle_day,
        daily_credit_limit: budget.daily_credit_limit,
    };
    Ok(RpcClient::new(Arc::new(transport), governor, clock))
}

/// The Helius WebSocket stream. Nothing is opened until a wallet is watched.
fn stream_connector(config: &Config) -> Result<Arc<dyn WsConnector>, Failure> {
    let endpoint = StreamEndpoint::helius_mainnet(&config.helius_api_key);
    let connector = TungsteniteConnector::new(endpoint).map_err(|error| {
        Failure::Unexpected(anyhow::Error::new(error).context("prepare the stream"))
    })?;
    Ok(Arc::new(connector))
}

async fn listen(address: SocketAddr) -> Result<TcpListener, Failure> {
    let listener = TcpListener::bind(address)
        .await
        .map_err(|error| Failure::io(format!("listen on {address}"), error))?;
    let bound = listener
        .local_addr()
        .map_err(|error| Failure::io("read the listening address", error))?;
    info!(url = %format_args!("http://{bound}"), "listening");
    Ok(listener)
}

/// Runs the engine and the server together. A cancelled `shutdown` (a stop signal), or either of
/// them ending (normally or not), stops both; once stopping, they get
/// [`SHUTDOWN_DEADLINE_SECS`] seconds.
async fn supervise(
    engine: Engine,
    state: AppState,
    listener: TcpListener,
    shutdown: CancellationToken,
) -> Result<(), Failure> {
    // The engine's future holds every ingestion worker: it lives on the heap, not in this one.
    let engine = stop_all_when_done(shutdown.clone(), async {
        Box::pin(engine.run(shutdown.clone()))
            .await
            .map_err(|error| Failure::Unexpected(error.into()))
    });
    let server = stop_all_when_done(shutdown.clone(), async {
        binsight_api::serve(listener, router(state), shutdown.clone())
            .await
            .map_err(|error| Failure::io("serve HTTP", error))
    });
    let deadline = async {
        shutdown.cancelled().await;
        tokio::time::sleep(Duration::from_secs(SHUTDOWN_DEADLINE_SECS)).await;
    };
    tokio::select! {
        (engine_outcome, server_outcome) = async { tokio::join!(engine, server) } => {
            engine_outcome.and(server_outcome)
        }
        () = deadline => Err(Failure::ShutdownTimedOut {
            deadline_secs: SHUTDOWN_DEADLINE_SECS,
        }),
    }
}

/// Runs `task`, then asks everything else to stop, whatever its outcome.
async fn stop_all_when_done<T>(shutdown: CancellationToken, task: impl Future<Output = T>) -> T {
    let outcome = task.await;
    shutdown.cancel();
    outcome
}
