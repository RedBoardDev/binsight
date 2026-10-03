//! Assembles the routes, the fallbacks and the middleware into the application router.
//!
//! Every API route is registered here together with its OpenAPI documentation, either as public or
//! behind the session guard. Every other path goes to the web app, except unknown `/api/` paths,
//! which get JSON errors, as do wrong methods. This module wires; handlers live in their own
//! modules.

use axum::Router;
use axum::middleware::from_fn_with_state;
use axum::response::{IntoResponse, Response};
use utoipa::OpenApi;
use utoipa_axum::router::OpenApiRouter;
use utoipa_axum::routes;

use crate::auth::{require_session, routes as auth};
use crate::error::{ApiError, ErrorCode};
use crate::openapi::ApiDoc;
use crate::state::AppState;
use crate::web_app::serve_web_app;
use crate::{health, layers, live, openapi};

/// The complete application: every route, its fallbacks and the middleware stack.
pub fn router(state: AppState) -> Router {
    let routes = DocumentedRoutes::new();
    let guard = from_fn_with_state(state.clone(), require_session);
    let (routes, _contract) = routes
        .public
        .merge(routes.protected.route_layer(guard))
        .split_for_parts();
    let cross_site_protection = state.auth.cross_site_protection();
    let application = routes
        .fallback(serve_web_app)
        .method_not_allowed_fallback(method_not_allowed)
        .with_state(state);
    layers::apply(application, cross_site_protection)
}

/// Every API route with its documentation; the same value produces the router and the contract.
pub(crate) struct DocumentedRoutes {
    /// Routes anyone may call.
    pub(crate) public: OpenApiRouter<AppState>,
    /// Routes that need a session; the router puts them behind the session guard.
    pub(crate) protected: OpenApiRouter<AppState>,
}

impl DocumentedRoutes {
    pub(crate) fn new() -> Self {
        let public = OpenApiRouter::with_openapi(ApiDoc::openapi())
            .routes(routes!(health::get_health))
            .routes(routes!(openapi::get_openapi))
            .routes(routes!(auth::login))
            .routes(routes!(auth::logout));
        let protected = OpenApiRouter::new()
            .routes(routes!(auth::get_session))
            .routes(routes!(live::stream_events));
        Self { public, protected }
    }
}

async fn method_not_allowed() -> Response {
    ApiError::new(
        ErrorCode::MethodNotAllowed,
        "this route does not accept this HTTP method",
    )
    .into_response()
}
