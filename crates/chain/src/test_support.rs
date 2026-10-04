//! Test doubles for the crates above the chain client, behind the `test-support` feature.
//!
//! A test scripts what the provider answers instead of reaching the network; everything else
//! (deadlines, retries, metering, parsing) runs for real. Compiled only for tests and with the
//! feature, which only dev-dependencies enable.

mod scripted_transport;

pub use scripted_transport::{ExpectationBuilder, RecordedCall, ScriptedReply, ScriptedTransport};
