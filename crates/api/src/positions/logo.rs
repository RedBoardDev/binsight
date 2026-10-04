//! `GET /api/v1/tokens/{mint}/logo`: a token's logo, served by binsight itself.
//!
//! Logos are same-origin so the content security policy stays `img-src 'self'` and the share
//! image canvas stays untainted. The URL clients get carries a version, so the image is cached
//! for a year; only raster images are ever stored.

use axum::extract::{Path, State};
use axum::http::{HeaderValue, header};
use axum::response::{IntoResponse, Response};
use binsight_solana::Address;

use crate::app::AppState;
use crate::error::{ApiError, ErrorBody, ErrorCode};

/// The URL of a logo is versioned by its content: it can be cached for good.
const CACHE_FOREVER: &str = "private, max-age=31536000, immutable";

/// Serves a token's logo.
#[utoipa::path(
    get,
    path = "/api/v1/tokens/{mint}/logo",
    operation_id = "getTokenLogo",
    tag = "positions",
    security(("session_cookie" = [])),
    params(("mint" = String, Path, description = "The token's mint (base58).")),
    responses(
        (status = 200, description = "The logo: a PNG, JPEG, WebP or GIF image, as its `content-type` says.", content_type = "image/png"),
        (status = 400, description = "The mint is not a valid address (`invalid_request`).", body = ErrorBody),
        (status = 401, description = "Not signed in (`unauthenticated`).", body = ErrorBody),
        (status = 404, description = "No logo is stored for this token (`not_found`).", body = ErrorBody),
        (status = 503, description = "The engine does not serve figures yet (`data_not_ready`).", body = ErrorBody),
    ),
)]
pub(crate) async fn get_token_logo(
    State(state): State<AppState>,
    Path(mint): Path<String>,
) -> Result<Response, ApiError> {
    let mint: Address = mint
        .parse()
        .map_err(|_| ApiError::new(ErrorCode::InvalidRequest, "mint: expected a base58 address"))?;
    let logo = state.engine.read_model().token_logo(mint).await?;
    let headers = [
        (
            header::CONTENT_TYPE,
            HeaderValue::from_static(logo.content_type),
        ),
        (
            header::CACHE_CONTROL,
            HeaderValue::from_static(CACHE_FOREVER),
        ),
    ];
    Ok((headers, logo.bytes.to_vec()).into_response())
}
