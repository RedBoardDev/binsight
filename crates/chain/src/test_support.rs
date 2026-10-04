//! Test doubles for the crates above the chain client, behind the `test-support` feature.
//!
//! A test scripts what the provider answers instead of reaching the network; everything else
//! (deadlines, retries, pacing, metering, parsing) runs for real. Compiled only for tests and with
//! the feature, which only dev-dependencies enable.

mod scripted_transport;

pub use scripted_transport::{ExpectationBuilder, RecordedCall, ScriptedReply, ScriptedTransport};

use std::sync::Arc;

use binsight_core::clock::Clock;
use binsight_core::credits::Credits;

use crate::governor::GovernorSettings;
use crate::plan::HeliusPlan;
use crate::rpc::RpcClient;

/// A client of the free plan that sends through `transport`, dated by `clock`, with an optional
/// hard daily limit.
pub fn scripted_client(
    transport: Arc<ScriptedTransport>,
    clock: Arc<dyn Clock>,
    daily_credit_limit: Option<Credits>,
) -> RpcClient {
    let settings = GovernorSettings::for_plan(HeliusPlan::Free, daily_credit_limit);
    RpcClient::new(transport, settings, clock)
}
