//! What a caller says about each RPC call: how urgent it is, what it is for and which wallet it
//! serves.
//!
//! The client uses the priority for its retry policy and the credit meter files the call under
//! all three, so the credit report can say where the credits went. This module only defines the
//! context.

use binsight_core::credits::{Priority, Purpose};
use binsight_solana::Address;

/// The context of one RPC call.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CallContext {
    /// How urgent the call is.
    pub priority: Priority,
    /// The work it belongs to.
    pub purpose: Purpose,
    /// The wallet it is made for, when it serves one.
    pub wallet: Option<Address>,
}
