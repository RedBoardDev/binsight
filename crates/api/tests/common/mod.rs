//! Shared helpers for the API tests: a real application on a temporary database, called in
//! process without any network.

#![allow(
    dead_code,
    reason = "each test binary uses a different part of these shared helpers"
)]

use std::sync::Arc;

use axum::Router;
use axum::body::{Body, Bytes};
use axum::http::{HeaderMap, Request, StatusCode};
use binsight_api::auth::{AuthSettings, OwnerPassword, PublicUrl, SessionSecret};
use binsight_api::{AppState, AppStateParts, router};
use binsight_core::clock::FixedClock;
use binsight_engine::test_support::temporary_engine;
use binsight_engine::{Engine, EngineHandle};
use http_body_util::BodyExt;
use jiff::Timestamp;
use tokio_util::sync::CancellationToken;
use tower::ServiceExt;

/// The owner's password in tests.
pub(crate) const PASSWORD: &str = "correct horse battery staple";

/// The instant every test application starts at.
pub(crate) const START_SECONDS: i64 = 1_790_000_000;

/// How to build a test application.
pub(crate) struct TestAppOptions {
    pub(crate) password: &'static str,
    pub(crate) secret_byte: u8,
    pub(crate) public_url: Option<&'static str>,
}

impl Default for TestAppOptions {
    fn default() -> Self {
        Self {
            password: PASSWORD,
            secret_byte: 42,
            public_url: None,
        }
    }
}

/// The application under test, with the engine (and its database) it runs on, its clock and its
/// shutdown signal.
pub(crate) struct TestApp {
    pub(crate) router: Router,
    pub(crate) state: AppState,
    pub(crate) clock: Arc<FixedClock>,
    pub(crate) shutdown: CancellationToken,
    pub(crate) handle: EngineHandle,
    engine: Option<Engine>,
    _database_folder: tempfile::TempDir,
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
    /// An application on a fresh temporary database, with the default options.
    pub(crate) async fn new() -> Self {
        Self::with(TestAppOptions::default()).await
    }

    /// An application on a fresh temporary database.
    pub(crate) async fn with(options: TestAppOptions) -> Self {
        let temporary = temporary_engine().await;
        let clock = Arc::new(FixedClock::new(
            Timestamp::from_second(START_SECONDS).unwrap(),
        ));
        let shutdown = CancellationToken::new();
        let state = AppState::new(AppStateParts {
            engine: temporary.handle.clone(),
            auth: AuthSettings {
                password: OwnerPassword::parse(options.password).unwrap(),
                session_secret: SessionSecret::from_bytes([options.secret_byte; 32]),
                public_url: options.public_url.map(|url| PublicUrl::parse(url).unwrap()),
            },
            clock: clock.clone(),
            shutdown: shutdown.clone(),
        });
        Self {
            router: router(state.clone()),
            state,
            clock,
            shutdown,
            handle: temporary.handle,
            engine: Some(temporary.engine),
            _database_folder: temporary.folder,
        }
    }

    /// Starts the engine in the background; it stops on the application's shutdown signal.
    pub(crate) fn start_engine(&mut self) -> tokio::task::JoinHandle<()> {
        let engine = self.engine.take().expect("the engine is already started");
        let shutdown = self.shutdown.clone();
        tokio::spawn(async move { engine.run(shutdown).await.unwrap() })
    }

    /// Moves the application's clock forwards.
    pub(crate) fn advance_clock(&self, seconds: i64) {
        self.clock
            .advance(jiff::SignedDuration::from_secs(seconds))
            .unwrap();
    }

    /// Sends `POST /api/v1/auth/login` with `password`, as a same-origin browser would.
    pub(crate) async fn login(&self, password: &str) -> TestResponse {
        let body = serde_json::json!({ "password": password }).to_string();
        let request = Request::post("/api/v1/auth/login")
            .header("content-type", "application/json")
            .header("sec-fetch-site", "same-origin")
            .body(Body::from(body))
            .unwrap();
        self.send(request).await
    }

    /// Logs in with the right password and returns the `name=value` of the session cookie.
    pub(crate) async fn session_cookie(&self) -> String {
        let response = self.login(PASSWORD).await;
        assert_eq!(response.status, StatusCode::OK);
        let set_cookie = response.header("set-cookie").unwrap();
        set_cookie.split(';').next().unwrap().to_owned()
    }

    /// Sends a `GET` to `path` with `cookie`.
    pub(crate) async fn get_with_cookie(&self, path: &str, cookie: &str) -> TestResponse {
        let request = Request::get(path)
            .header("cookie", cookie)
            .body(Body::empty())
            .unwrap();
        self.send(request).await
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
