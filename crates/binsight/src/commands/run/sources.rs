//! What the server reads from: the RPC client the engine ingests through, and the source of the
//! figures the API serves (the chain, or a generated demo world).
//!
//! In demo mode there is no Helius key: the RPC client then never reaches the network, so no
//! credit can be spent even if the data folder tracks wallets.

use std::sync::Arc;

use binsight_chain::{
    GovernorSettings, HttpTransport, RpcClient, RpcEndpoint, RpcTransport, SendFuture,
    TransportError,
};
use binsight_core::clock::Clock;
use binsight_demo::{DemoPortfolio, WorldSpec};
use binsight_engine::portfolio::DataSource;
use jiff::tz::TimeZone;
use tracing::{info, warn};

use crate::config::{Config, DataSourceConfig};
use crate::failure::Failure;

/// The RPC client: the Helius provider in chain mode (nothing is sent until the engine has a
/// wallet to ingest), a client that never reaches the network in demo mode.
pub(super) fn rpc_client(config: &Config, clock: Arc<dyn Clock>) -> Result<RpcClient, Failure> {
    let transport: Arc<dyn RpcTransport> = match &config.data_source {
        DataSourceConfig::Chain { helius_api_key } => {
            let endpoint = RpcEndpoint::helius_mainnet(helius_api_key);
            let transport = HttpTransport::new(endpoint).map_err(|error| {
                Failure::Unexpected(anyhow::Error::new(error).context("prepare the RPC client"))
            })?;
            Arc::new(transport)
        }
        DataSourceConfig::Demo => Arc::new(OfflineTransport),
    };
    let budget = config.credit_budget;
    info!(
        plan = %budget.plan,
        daily_credit_limit = budget.daily_credit_limit.map(|limit| limit.0),
        "rpc credit budget"
    );
    let governor = GovernorSettings::for_plan(budget.plan, budget.daily_credit_limit);
    Ok(RpcClient::new(transport, governor, clock))
}

/// The source of the figures: the chain, or a demo world generated now (in UTC until the instance
/// has a time zone setting).
pub(super) fn data_source(
    config: &DataSourceConfig,
    clock: &Arc<dyn Clock>,
) -> Result<DataSource, Failure> {
    match config {
        DataSourceConfig::Chain { .. } => Ok(DataSource::Chain),
        DataSourceConfig::Demo => {
            warn!("demo mode: serving generated figures; nothing reaches the network");
            let spec = WorldSpec::new(clock.now(), TimeZone::UTC);
            let portfolio = DemoPortfolio::new(&spec, Arc::clone(clock))
                .map_err(|error| Failure::Unexpected(error.into()))?;
            Ok(DataSource::Demo(Arc::new(portfolio)))
        }
    }
}

/// The transport of demo mode: every request fails before leaving the process.
struct OfflineTransport;

impl RpcTransport for OfflineTransport {
    fn send(&self, _body: Vec<u8>) -> SendFuture<'_> {
        Box::pin(std::future::ready(Err(TransportError::Connect {
            detail: "demo mode never reaches the network".to_owned(),
        })))
    }
}
