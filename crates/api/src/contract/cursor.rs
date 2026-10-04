//! Page cursors: what a list needs to read its next page, written as an opaque string that
//! clients only pass back.
//!
//! A cursor is the JSON of a route's own state (the key of the last row, and whatever the next
//! page must match), with a version, in URL-safe base64. A cursor that cannot be read, or that
//! belongs to another query, answers `400 invalid_cursor`: the client starts again from the first
//! page. This module writes and reads cursors; each route decides what goes in them.

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};

use crate::error::{ApiError, ErrorCode};

/// The version of the cursor format; a cursor of another version is refused.
const CURSOR_VERSION: u8 = 1;

/// A cursor's content: its version and the route's state.
#[derive(Serialize, Deserialize)]
struct Envelope<T> {
    v: u8,
    state: T,
}

/// Writes `state` as an opaque cursor.
pub(crate) fn encode_cursor<T: Serialize>(state: T) -> String {
    let envelope = Envelope {
        v: CURSOR_VERSION,
        state,
    };
    // Serializing a plain struct of strings and numbers to JSON cannot fail.
    let json = serde_json::to_vec(&envelope).unwrap_or_default();
    URL_SAFE_NO_PAD.encode(json)
}

/// Reads the state of the opaque cursor `text`.
///
/// # Errors
///
/// Returns `400 invalid_cursor` when it is not a cursor of this version holding a `T`.
pub(crate) fn decode_cursor<T: DeserializeOwned>(text: &str) -> Result<T, ApiError> {
    let invalid = || {
        ApiError::new(
            ErrorCode::InvalidCursor,
            "cursor: not a cursor of this list; start again from the first page",
        )
    };
    let json = URL_SAFE_NO_PAD.decode(text).map_err(|_| invalid())?;
    let envelope: Envelope<T> = serde_json::from_slice(&json).map_err(|_| invalid())?;
    if envelope.v != CURSOR_VERSION {
        return Err(invalid());
    }
    Ok(envelope.state)
}

/// Builds the error of a cursor that is readable but belongs to another query.
pub(crate) fn foreign_cursor() -> ApiError {
    ApiError::new(
        ErrorCode::InvalidCursor,
        "cursor: it belongs to another query; start again from the first page",
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Debug, PartialEq, Serialize, Deserialize)]
    struct State {
        after: String,
    }

    #[test]
    fn reads_back_the_state_it_writes() {
        let state = State {
            after: "abc".to_owned(),
        };

        let cursor = encode_cursor(&state);

        assert_eq!(decode_cursor::<State>(&cursor).unwrap(), state);
    }

    #[test]
    fn refuses_garbage_and_another_shape() {
        let other = encode_cursor([1, 2, 3]);

        assert!(decode_cursor::<State>("not a cursor!").is_err());
        assert!(decode_cursor::<State>(&other).is_err());
    }
}
