//! The OpenAPI contract of the API, generated from the code.
//!
//! Routes are registered together with their documentation (see `router`), so the contract
//! cannot drift from the code. The contract is committed as `openapi/v1.json` and a test fails
//! when it is stale (`just openapi` regenerates it); it is also served at
//! `GET /api/v1/openapi.json`. Its version is the version of the contract, not of the binary.

use axum::http::header;
use axum::response::IntoResponse;
use utoipa::openapi::security::{ApiKey, ApiKeyValue, SecurityScheme};
use utoipa::{Modify, OpenApi};

use crate::app::DocumentedRoutes;
use crate::auth::SESSION_COOKIE_NAME;
use crate::error::{ErrorBody, ErrorCode, ErrorDetail};

/// The version of the API contract. A compatible addition bumps the minor version; a breaking
/// change gets a new `/api/v2` instead.
pub const API_CONTRACT_VERSION: &str = "1.2.0";

/// The parts of the contract that are not routes: metadata and shared schemas.
#[derive(OpenApi)]
#[openapi(
    info(
        title = "binsight",
        version = API_CONTRACT_VERSION,
        description = "The HTTP API of a binsight server: health, authentication, live events, \
            the tracked wallets, their synchronization and the settings of the instance. Amounts, \
            prices and percentages are canonical decimal strings; every figure carries its \
            exactness.",
        license(name = "MIT", identifier = "MIT"),
    ),
    components(schemas(ErrorBody, ErrorDetail, ErrorCode)),
    modifiers(&SessionCookie),
    tags(
        (name = "system", description = "The state of the server and its contract."),
        (name = "auth", description = "Signing in and out with the owner's password."),
        (name = "live", description = "Events pushed to the clients as they happen."),
        (name = "wallets", description = "The tracked wallets and their figures."),
        (name = "settings", description = "The settings every client of the instance shares."),
        (name = "portfolio", description = "The overview of the portfolio."),
        (name = "positions", description = "Liquidity positions and their tokens."),
        (name = "stats", description = "Statistics and chart series."),
    ),
)]
pub(crate) struct ApiDoc;

/// Declares the `session_cookie` security scheme that protected operations refer to.
struct SessionCookie;

impl Modify for SessionCookie {
    fn modify(&self, openapi: &mut utoipa::openapi::OpenApi) {
        let components = openapi.components.get_or_insert_with(Default::default);
        components.add_security_scheme(
            "session_cookie",
            SecurityScheme::ApiKey(ApiKey::Cookie(ApiKeyValue::new(SESSION_COOKIE_NAME))),
        );
    }
}

/// The contract, built from the registered routes.
pub fn spec() -> utoipa::openapi::OpenApi {
    let routes = DocumentedRoutes::new();
    routes.public.merge(routes.protected).into_openapi()
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
