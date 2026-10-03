//! Assembles the routes, the fallbacks and the middleware into the application router.
//!
//! Every API route is registered here together with its OpenAPI documentation. Unknown paths and
//! wrong methods get JSON errors. This module wires; handlers live in their own modules.

use axum::Router;
use axum::http::Uri;
use axum::response::{IntoResponse, Response};
use utoipa::OpenApi;
use utoipa_axum::router::OpenApiRouter;
use utoipa_axum::routes;

use crate::error::{ApiError, ErrorCode};
use crate::openapi::ApiDoc;
use crate::state::AppState;
use crate::{health, layers, openapi};

/// The complete application: every route, its fallbacks and the middleware stack.
pub fn router(state: AppState) -> Router {
    let (routes, _contract) = documented_routes().split_for_parts();
    let application = routes
        .fallback(route_not_found)
        .method_not_allowed_fallback(method_not_allowed)
        .with_state(state);
    layers::apply(application)
}

/// The documented routes; the same value produces the router and the OpenAPI contract.
pub(crate) fn documented_routes() -> OpenApiRouter<AppState> {
    OpenApiRouter::with_openapi(ApiDoc::openapi())
        .routes(routes!(health::get_health))
        .routes(routes!(openapi::get_openapi))
}

async fn route_not_found(uri: Uri) -> Response {
    let message = format!("there is no route at {}", uri.path());
    ApiError::new(ErrorCode::NotFound, message).into_response()
}

async fn method_not_allowed() -> Response {
    ApiError::new(
        ErrorCode::MethodNotAllowed,
        "this route does not accept this HTTP method",
    )
    .into_response()
}
