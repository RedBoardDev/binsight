//! Shared helpers for the API tests: a real application on a temporary database, called in
//! process without any network.

#![allow(
    dead_code,
    reason = "each test binary uses a different part of these shared helpers"
)]

pub(crate) mod figures;
pub(crate) mod positions;

use std::net::SocketAddr;
use std::sync::Arc;

use axum::Router;
use axum::body::{Body, Bytes};
use axum::extract::ConnectInfo;
use axum::http::{HeaderMap, HeaderName, Request, StatusCode};
use binsight_api::auth::{AuthSettings, ClientIpHeader, OwnerPassword, PublicUrl, SessionSecret};
use binsight_api::{AppState, AppStateParts, WebAsset, WebAssets, router};
use binsight_core::clock::FixedClock;
use binsight_demo::{DemoPortfolio, WorldSpec};
use binsight_engine::portfolio::DataSource;
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

/// The time zone of the demo world of every test application.
pub(crate) const TEST_TIMEZONE: &str = "Europe/Paris";

/// The web app files of every test application.
pub(crate) const INDEX_HTML: &str = "<!doctype html><title>binsight</title>";

/// A few web app files, in memory.
pub(crate) struct FakeWebAssets;

impl WebAssets for FakeWebAssets {
    fn get(&self, path: &str) -> Option<WebAsset> {
        let (bytes, content_type, hash_byte): (&'static [u8], &str, u8) = match path {
            "index.html" => (INDEX_HTML.as_bytes(), "text/html", 1),
            "assets/app-1a2b.js" => (b"console.log('app');", "text/javascript", 2),
            "manifest.webmanifest" => (b"{}", "application/manifest+json", 3),
            _ => return None,
        };
        Some(WebAsset {
            bytes: bytes.into(),
            content_type: content_type.to_owned(),
            sha256: [hash_byte; 32],
        })
    }
}

/// Where a test application takes its figures from.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum Figures {
    /// The chain: the engine serves nothing yet.
    Chain,
    /// The default demo world, anchored at the start instant in Europe/Paris.
    Demo,
}

/// How to build a test application.
pub(crate) struct TestAppOptions {
    pub(crate) figures: Figures,
    pub(crate) password: &'static str,
    pub(crate) secret_byte: u8,
    pub(crate) public_url: Option<&'static str>,
    pub(crate) client_ip_header: Option<&'static str>,
}

impl Default for TestAppOptions {
    fn default() -> Self {
        Self {
            figures: Figures::Chain,
            password: PASSWORD,
            secret_byte: 42,
            public_url: None,
            client_ip_header: None,
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

/// `POST /api/v1/auth/login` with `password`, as a same-origin browser sends it.
fn login_request(password: &str) -> Request<Body> {
    let body = serde_json::json!({ "password": password }).to_string();
    Request::post("/api/v1/auth/login")
        .header("content-type", "application/json")
        .header("sec-fetch-site", "same-origin")
        .body(Body::from(body))
        .unwrap()
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

    /// An application serving the default demo world, signed-in requests made easy.
    pub(crate) async fn demo() -> Self {
        Self::with(TestAppOptions {
            figures: Figures::Demo,
            ..TestAppOptions::default()
        })
        .await
    }

    /// An application on a fresh temporary database.
    pub(crate) async fn with(options: TestAppOptions) -> Self {
        let temporary = temporary_engine().await;
        let start = Timestamp::from_second(START_SECONDS).unwrap();
        let clock = Arc::new(FixedClock::new(start));
        let shutdown = CancellationToken::new();
        let data_source = match options.figures {
            Figures::Chain => DataSource::Chain,
            Figures::Demo => {
                let spec = WorldSpec::new(start, jiff::tz::TimeZone::get(TEST_TIMEZONE).unwrap());
                DataSource::Demo(Arc::new(DemoPortfolio::new(&spec, clock.clone()).unwrap()))
            }
        };
        let handle = temporary.handle.with_data_source(data_source);
        let state = AppState::new(AppStateParts {
            engine: handle.clone(),
            auth: AuthSettings {
                password: OwnerPassword::parse(options.password).unwrap(),
                session_secret: SessionSecret::from_bytes([options.secret_byte; 32]),
                public_url: options.public_url.map(|url| PublicUrl::parse(url).unwrap()),
                client_ip_header: options
                    .client_ip_header
                    .map(|header| ClientIpHeader::parse(header).unwrap()),
            },
            clock: clock.clone(),
            shutdown: shutdown.clone(),
            web_assets: Arc::new(FakeWebAssets),
        });
        Self {
            router: router(state.clone()),
            state,
            clock,
            shutdown,
            handle,
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
        self.send(login_request(password)).await
    }

    /// Like [`TestApp::login`], over a connection from `peer`, with the extra `headers`.
    pub(crate) async fn login_from(
        &self,
        password: &str,
        peer: &str,
        headers: &[(&str, &str)],
    ) -> TestResponse {
        let mut request = login_request(password);
        let address: SocketAddr = peer.parse().unwrap();
        request.extensions_mut().insert(ConnectInfo(address));
        for (name, value) in headers {
            request
                .headers_mut()
                .insert(HeaderName::try_from(*name).unwrap(), value.parse().unwrap());
        }
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

    /// Signs in and sends a `GET` to `path`.
    pub(crate) async fn get_signed_in(&self, path: &str) -> TestResponse {
        let cookie = self.session_cookie().await;
        self.get_with_cookie(path, &cookie).await
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
