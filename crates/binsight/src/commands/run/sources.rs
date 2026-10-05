//! What the server reads from: the engine on the chain, through the Helius provider, or the
//! generated demo world, which runs no engine at all.
//!
//! Demo mode never starts ingestion: nothing is sent to the network, no credit is counted and
//! nothing is written to the database. It also refuses a data folder that tracks wallets, so a
//! demo can never run on the folder of a real instance.

use std::path::Path;
use std::sync::Arc;

use binsight_chain::{
    GovernorSettings, HeliusApiKey, HttpTransport, RpcClient, RpcEndpoint, StreamEndpoint,
    TungsteniteConnector, WsConnector,
};
use binsight_core::clock::Clock;
use binsight_demo::{DemoPortfolio, WorldSpec};
use binsight_engine::portfolio::DataSource;
use binsight_engine::{Engine, EngineHandle};
use binsight_store::Store;
use jiff::tz::TimeZone;
use tracing::{info, warn};

use crate::config::{Config, DataSourceConfig};
use crate::failure::Failure;

/// The engine and its handle in chain mode; only a handle in demo mode.
pub(super) async fn engine(
    config: &Config,
    store: &Store,
    clock: &Arc<dyn Clock>,
) -> Result<(Option<Engine>, EngineHandle), Failure> {
    match &config.data_source {
        DataSourceConfig::Chain { helius_api_key } => {
            let rpc = rpc_client(helius_api_key, config, Arc::clone(clock))?;
            let stream = stream_connector(helius_api_key)?;
            let (engine, handle) = Engine::new(store.clone(), rpc, stream, Arc::clone(clock));
            Ok((Some(engine), handle.with_data_source(DataSource::Chain)))
        }
        DataSourceConfig::Demo => {
            refuse_tracked_wallets(store, &config.data_dir).await?;
            warn!("demo mode: serving generated figures; nothing is tracked or sent");
            let spec = WorldSpec::new(clock.now(), TimeZone::UTC);
            let portfolio =
                DemoPortfolio::new(&spec).map_err(|error| Failure::Unexpected(error.into()))?;
            let source = DataSource::Demo(Arc::new(portfolio));
            Ok((None, EngineHandle::without_engine(store.clone(), source)))
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

/// Refuses a data folder that tracks wallets: demo figures must never sit next to real ones.
async fn refuse_tracked_wallets(store: &Store, data_dir: &Path) -> Result<(), Failure> {
    if store.wallets().list().await?.is_empty() {
        return Ok(());
    }
    Err(Failure::DemoOnTrackedData {
        path: data_dir.to_path_buf(),
    })
}
