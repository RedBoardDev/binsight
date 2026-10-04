//! The `{position_id}` path segment: a position's permanent id, `<address>-<opening signature>`.

use binsight_ledger::facts::PositionId;

use crate::error::{ApiError, ErrorCode};

/// Reads the position id of a path.
///
/// # Errors
///
/// Returns `400 invalid_request` when it is not `<address>-<signature>` in base58.
pub(crate) fn parse_position_id(text: &str) -> Result<PositionId, ApiError> {
    text.parse().map_err(|_| {
        ApiError::new(
            ErrorCode::InvalidRequest,
            "position_id: expected `<address>-<opening signature>`, both in base58",
        )
    })
}
