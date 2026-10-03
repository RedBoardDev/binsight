//! Shared helpers for the API tests: a real application on a temporary database, called in
//! process without any network.

#![allow(
    dead_code,
    reason = "each test binary uses a different part of these shared helpers"
)]

use axum::Router;
use axum::body::{Body, Bytes};
use axum::http::{HeaderMap, Request, StatusCode};
use binsight_api::{AppState, router};
use binsight_engine::test_support::{TemporaryEngine, temporary_engine};
use http_body_util::BodyExt;
use tower::ServiceExt;

/// The application under test, with the engine (and its database) it runs on.
pub(crate) struct TestApp {
    pub(crate) router: Router,
    pub(crate) engine: TemporaryEngine,
}

/// A response, fully read.
pub(crate) struct TestResponse {
    pub(crate) status: StatusCode,
    pub(crate) headers: HeaderMap,
    pub(crate) body: Bytes,
}

impl TestResponse {
    /// The body parsed as JSON.
    pub(crate) fn json(&self) -> serde_json::Value {
        serde_json::from_slice(&self.body).expect("the body is not JSON")
    }

    /// A response header as text.
    pub(crate) fn header(&self, name: &str) -> Option<&str> {
        self.headers.get(name).map(|value| value.to_str().unwrap())
    }
}

impl TestApp {
    /// An application on a fresh temporary database.
    pub(crate) async fn new() -> Self {
        let engine = temporary_engine().await;
        let router = router(AppState::new(engine.handle.clone()));
        Self { router, engine }
    }

    /// Sends `request` through the whole application and reads the response.
    pub(crate) async fn send(&self, request: Request<Body>) -> TestResponse {
        let response = self.router.clone().oneshot(request).await.unwrap();
        let status = response.status();
        let headers = response.headers().clone();
        let body = response.into_body().collect().await.unwrap().to_bytes();
        TestResponse {
            status,
            headers,
            body,
        }
    }

    /// Sends a `GET` to `path`.
    pub(crate) async fn get(&self, path: &str) -> TestResponse {
        self.send(Request::get(path).body(Body::empty()).unwrap())
            .await
    }
}
