//! The shapes every route of the API shares: exact amounts, figures with their exactness and
//! reasons, references to wallets, and the reading of query strings.
//!
//! Amounts, prices, percentages and ratios always travel as canonical decimal strings, never as
//! JSON numbers; numbers are only counts and durations. A figure is a union tagged by its
//! exactness, so an unavailable figure has no value at all. This module defines the wire forms
//! and converts the engine's views to them; it holds no rule.

mod decimal;
mod figure;
mod money;
mod query;
mod reason;
mod wallet_ref;

pub(crate) use decimal::DecimalString;
pub(crate) use figure::{Figure, PercentFigure};
pub(crate) use query::{ApiQuery, Currency, CurrencyQuery};
pub(crate) use wallet_ref::WalletRef;
