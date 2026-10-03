//! The OpenAPI contract of the API, generated from the code.
//!
//! Routes are registered together with their documentation (see `router`), so the contract
//! cannot drift from the code. The contract is committed as `openapi/v1.json` and a test fails
//! when it is stale (`just openapi` regenerates it); it is also served at
//! `GET /api/v1/openapi.json`. Its version is the version of the contract, not of the binary.

use axum::http::header;
use axum::response::IntoResponse;
use utoipa::OpenApi;

use crate::error::{ErrorBody, ErrorCode, ErrorDetail};

/// The version of the API contract. A compatible addition bumps the minor version; a breaking
/// change gets a new `/api/v2` instead.
pub const API_CONTRACT_VERSION: &str = "1.0.0";

/// The parts of the contract that are not routes: metadata and shared schemas.
#[derive(OpenApi)]
#[openapi(
    info(
        title = "binsight",
        version = API_CONTRACT_VERSION,
        description = "The HTTP API of a binsight server: health, authentication and live events.",
        license(name = "MIT", identifier = "MIT"),
    ),
    components(schemas(ErrorBody, ErrorDetail, ErrorCode)),
    tags((name = "system", description = "The state of the server and its contract.")),
)]
pub(crate) struct ApiDoc;

/// The contract, built from the registered routes.
pub fn spec() -> utoipa::openapi::OpenApi {
    crate::router::documented_routes().into_openapi()
}

/// The contract as pretty-printed JSON, exactly as committed in `openapi/v1.json`.
pub fn spec_json() -> String {
    let mut json = spec().to_pretty_json().unwrap_or_default();
    json.push('\n');
    json
}

/// Serves the contract.
#[utoipa::path(
    get,
    path = "/api/v1/openapi.json",
    operation_id = "getOpenApi",
    tag = "system",
    responses((status = 200, description = "This contract, as OpenAPI 3.1 JSON.", content_type = "application/json")),
)]
pub(crate) async fn get_openapi() -> impl IntoResponse {
    ([(header::CONTENT_TYPE, "application/json")], spec_json())
}
