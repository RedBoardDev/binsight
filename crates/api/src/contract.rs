//! The shapes every route of the API shares: exact amounts, figures with their exactness and
//! reasons, references to wallets, and the reading of query strings.
//!
//! Amounts, prices, percentages and ratios always travel as canonical decimal strings, never as
//! JSON numbers; numbers are only counts and durations. A figure is a union tagged by its
//! exactness, so an unavailable figure has no value at all. This module defines the wire forms
//! and converts the engine's views to them; it holds no rule.

mod cursor;
mod decimal;
mod figure;
mod freshness;
mod links;
mod money;
mod open_position;
mod position;
mod query;
mod token;
mod wallet_ref;
mod window;

pub(crate) use cursor::{decode_cursor, encode_cursor, foreign_cursor};
pub(crate) use decimal::DecimalString;
pub(crate) use figure::{Figure, PercentFigure};
pub(crate) use freshness::{Freshness, SyncState};
pub(crate) use links::{PositionLinks, WalletLinks};
pub(crate) use open_position::{BinChart, OpenMethod, OpenPositionRow, RangeInfo};
pub(crate) use position::{ClosedPositionRow, ClosedTotals, Outcome, PnlMethod, Strategy};
pub(crate) use query::{ApiQuery, Currency, CurrencyQuery, Order, ScopeQuery, comma_list};
pub(crate) use token::{PoolRef, Price, TokenRef};
pub(crate) use wallet_ref::WalletRef;
pub(crate) use window::{PeriodQuery, Window};
