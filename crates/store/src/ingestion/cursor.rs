//! How far a wallet's signatures are listed, and its form in the `wallet_cursor` table.
//!
//! The cursor is an enum so that only consistent states exist: a history being listed always has
//! a top and a page to continue from, and a cursor that never listed a page has neither. The
//! engine decides how a cursor moves; this module only names the states and stores them.

use binsight_solana::Signature;
use rusqlite::Row;

use crate::database::codec::{parse_from_sql, unsigned_from_sql, unsigned_to_sql};
use crate::error::StoreError;

/// The newest signature listed for a wallet.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ListedTop {
    /// The signature.
    pub signature: Signature,
    /// The slot it landed in.
    pub slot: u64,
}

/// How far a wallet's signatures are listed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WalletCursor {
    /// No page was listed yet.
    NotStarted,
    /// The newest pages are listed; older signatures remain, listed from `before` downwards.
    ListingHistory {
        /// The newest signature listed.
        top: ListedTop,
        /// The next history page lists the signatures older than this one.
        before: Signature,
    },
    /// Every signature down to the wallet's first transaction is listed.
    HistoryComplete {
        /// The newest signature listed, or `None` for a wallet without any transaction.
        top: Option<ListedTop>,
    },
}

impl WalletCursor {
    /// The newest signature listed, if any.
    pub fn top(&self) -> Option<ListedTop> {
        match *self {
            Self::NotStarted => None,
            Self::ListingHistory { top, .. } => Some(top),
            Self::HistoryComplete { top } => top,
        }
    }
}

/// The cursor's columns, in the order of the `wallet_cursor` table:
/// `(top_signature, top_slot, history_before, history_state)`.
pub(super) type CursorColumns = (Option<String>, Option<i64>, Option<String>, &'static str);

/// The columns that store `cursor`.
pub(super) fn cursor_to_sql(cursor: &WalletCursor) -> Result<CursorColumns, StoreError> {
    let top_columns =
        |top: Option<ListedTop>| -> Result<(Option<String>, Option<i64>), StoreError> {
            match top {
                None => Ok((None, None)),
                Some(top) => Ok((
                    Some(top.signature.to_string()),
                    Some(unsigned_to_sql(top.slot, "slot")?),
                )),
            }
        };
    Ok(match *cursor {
        WalletCursor::NotStarted => (None, None, None, "not_started"),
        WalletCursor::ListingHistory { top, before } => {
            let (signature, slot) = top_columns(Some(top))?;
            (signature, slot, Some(before.to_string()), "listing")
        }
        WalletCursor::HistoryComplete { top } => {
            let (signature, slot) = top_columns(top)?;
            (signature, slot, None, "complete")
        }
    })
}

/// Reads a cursor from a row whose columns `first..first + 4` are the [`CursorColumns`].
pub(super) fn cursor_from_row(row: &Row<'_>, first: usize) -> Result<WalletCursor, StoreError> {
    let top_signature: Option<String> = row.get(first)?;
    let top_slot: Option<i64> = row.get(first + 1)?;
    let before: Option<String> = row.get(first + 2)?;
    let state: String = row.get(first + 3)?;
    let top = match (top_signature, top_slot) {
        (Some(signature), Some(slot)) => Some(ListedTop {
            signature: parse_from_sql(&signature, "signature")?,
            slot: unsigned_from_sql(slot, "slot")?,
        }),
        _ => None,
    };
    match (state.as_str(), top, before) {
        ("not_started", None, None) => Ok(WalletCursor::NotStarted),
        ("listing", Some(top), Some(before)) => Ok(WalletCursor::ListingHistory {
            top,
            before: parse_from_sql(&before, "signature")?,
        }),
        ("complete", top, None) => Ok(WalletCursor::HistoryComplete { top }),
        _ => Err(StoreError::InvalidStoredValue {
            what: "wallet cursor",
            value: state,
        }),
    }
}
