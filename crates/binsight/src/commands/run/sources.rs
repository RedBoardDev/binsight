//! What the server reads from: the engine on the chain, through the Helius provider, or the
//! generated demo world, which runs no engine at all.
//!
//! Demo mode never starts ingestion: nothing is sent to the network and no credit is counted. It
//! keeps its data in a folder of its own (the `demo` subfolder of the data folder), and refuses
//! that folder if it tracks wallets, which it checks read-only before opening anything, so a demo
//! can never back up, migrate or write the database of a real instance.

use std::sync::Arc;

use binsight_chain::{
    GovernorSettings, HeliusApiKey, HttpTransport, RpcClient, RpcEndpoint, StreamEndpoint,
    TungsteniteConnector, WsConnector,
};
use binsight_core::clock::Clock;
use binsight_demo::{DemoPortfolio, WorldSpec};
use binsight_engine::{Engine, EngineHandle};
use binsight_store::Store;
use jiff::tz::TimeZone;
use tracing::{info, warn};

use crate::config::{Config, DataSourceConfig};
use crate::data_dir::database_path;
use crate::failure::Failure;

/// The engine and its handle in chain mode; only a handle in demo mode.
pub(super) fn engine(
    config: &Config,
    store: &Store,
    clock: &Arc<dyn Clock>,
) -> Result<(Option<Engine>, EngineHandle), Failure> {
    match &config.data_source {
        DataSourceConfig::Chain { helius_api_key } => {
            let rpc = rpc_client(helius_api_key, config, Arc::clone(clock))?;
            let stream = stream_connector(helius_api_key)?;
            let (engine, handle) = Engine::new(store.clone(), rpc, stream, Arc::clone(clock));
            Ok((Some(engine), handle))
        }
        DataSourceConfig::Demo => {
            warn!("demo mode: serving generated figures; nothing is tracked or sent");
            let spec = WorldSpec::new(clock.now(), TimeZone::UTC);
            let portfolio =
                DemoPortfolio::new(&spec).map_err(|error| Failure::Unexpected(error.into()))?;
            Ok((
                None,
                EngineHandle::without_engine(store.clone(), Arc::new(portfolio)),
            ))
        }
    }
}

/// The Helius client. Nothing is sent until the engine has a wallet to ingest.
fn rpc_client(
    key: &HeliusApiKey,
    config: &Config,
    clock: Arc<dyn Clock>,
) -> Result<RpcClient, Failure> {
    let transport = HttpTransport::new(RpcEndpoint::helius_mainnet(key)).map_err(|error| {
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

/// The Helius stream, constructed only in chain mode; no connection opens until watched.
fn stream_connector(key: &HeliusApiKey) -> Result<Arc<dyn WsConnector>, Failure> {
    let connector =
        TungsteniteConnector::new(StreamEndpoint::helius_mainnet(key)).map_err(|error| {
            Failure::Unexpected(anyhow::Error::new(error).context("prepare the stream"))
        })?;
    Ok(Arc::new(connector))
}

/// In demo mode, refuses a data folder that tracks wallets: demo figures must never sit next to
/// real ones. The database is only read, before anything opens it for writing.
pub(super) async fn refuse_tracked_demo_folder(config: &Config) -> Result<(), Failure> {
    if !matches!(config.data_source, DataSourceConfig::Demo) {
        return Ok(());
    }
    let database = database_path(&config.data_dir);
    let tracks_wallets = tokio::task::spawn_blocking(move || Store::tracks_wallets(&database))
        .await
        .map_err(|error| Failure::Unexpected(error.into()))??;
    if tracks_wallets {
        return Err(Failure::DemoOnTrackedData {
            path: config.data_dir.clone(),
        });
    }
    Ok(())
}
