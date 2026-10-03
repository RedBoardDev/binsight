//! How every failure becomes the same JSON error body.
//!
//! Handlers and layers return an [`ApiError`]: a stable [`ErrorCode`] (the clients' translation
//! key) and an English message for debugging. A single middleware then writes the body
//! `{"error":{"code":…,"message":…,"request_id":…}}`, because only it knows the request id. Server
//! errors are logged there with their detail and never send it to the client.

mod api_error;
mod code;
mod json;
mod rendering;

pub(crate) use api_error::ApiError;
pub(crate) use code::ErrorCode;
pub(crate) use json::ApiJson;
pub(crate) use rendering::{ErrorBody, ErrorDetail};
pub(crate) use rendering::{REQUEST_ID_HEADER, render_error_bodies};
