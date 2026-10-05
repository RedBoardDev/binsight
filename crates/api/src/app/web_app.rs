//! Serves the web app (a single-page application) for every path that is not an API route.
//!
//! The files come from a [`WebAssets`] source: the binary embeds the web build, tests use files
//! in memory. The rules:
//! - `/api/...` paths that match no route get a JSON 404, never the web app;
//! - only `GET` and `HEAD` are served;
//! - a known file is served with its content type and a weak `ETag` (a matching `If-None-Match`
//!   gets `304`); weak, because compression sends different bytes for the same content; files under `assets/` have content-hashed names and are cached for a year, every
//!   other file (`index.html`, the service worker, the manifest) is revalidated on each use;
//! - an unknown path without an extension is a page of the app: it gets `index.html`, and the
//!   app's router takes over; an unknown path with an extension is a missing file: `404`.

use std::fmt::Write;

use axum::body::Body;
use axum::extract::State;
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode, Uri, header};
use axum::response::{IntoResponse, Response};

use super::state::AppState;
use crate::error::{ApiError, ErrorCode};

/// The page served for every path of the app, as a [`WebAssets`] source names it.
pub const INDEX_FILE: &str = "index.html";

/// Where the build puts its content-hashed files.
const HASHED_FILES_FOLDER: &str = "assets/";

/// Content-hashed files never change: they can be kept for a year.
const CACHE_FOREVER: &str = "public, max-age=31536000, immutable";

/// Everything else must be revalidated, so a new version is picked up at once.
const CACHE_REVALIDATE: &str = "no-cache";

/// One file of the web app.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WebAsset {
    /// The file content.
    pub bytes: std::borrow::Cow<'static, [u8]>,
    /// Its media type, such as `text/html` or `application/manifest+json`.
    pub content_type: String,
    /// The SHA-256 of the content, used as its `ETag`.
    pub sha256: [u8; 32],
}

/// Where the files of the web app come from.
pub trait WebAssets: Send + Sync {
    /// The file at `path`, relative to the root of the web build (`index.html`,
    /// `assets/app-1a2b.js`), if there is one.
    fn get(&self, path: &str) -> Option<WebAsset>;
}

/// The fallback handler: serves the web app as described in the module documentation.
pub(crate) async fn serve_web_app(
    State(state): State<AppState>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
) -> Response {
    let path = uri.path();
    if path == "/api" || path.starts_with("/api/") {
        return ApiError::new(ErrorCode::NotFound, format!("there is no route at {path}"))
            .into_response();
    }
    if method != Method::GET && method != Method::HEAD {
        return ApiError::new(
            ErrorCode::MethodNotAllowed,
            "the web app is only served to GET and HEAD requests",
        )
        .into_response();
    }
    let Some((file, asset)) = find_file(state.web_assets.as_ref(), path) else {
        return ApiError::new(ErrorCode::NotFound, format!("there is no file at {path}"))
            .into_response();
    };
    file_response(
        &asset,
        cache_policy(&file),
        &headers,
        method == Method::HEAD,
    )
}

/// The file to serve for `path` and its name, following the fallback rules.
fn find_file(assets: &dyn WebAssets, path: &str) -> Option<(String, WebAsset)> {
    let relative = path.trim_start_matches('/');
    if relative.split('/').any(|segment| segment == "..") {
        return None;
    }
    let file = if relative.is_empty() {
        INDEX_FILE
    } else {
        relative
    };
    if let Some(asset) = assets.get(file) {
        return Some((file.to_owned(), asset));
    }
    let last_segment = file.rsplit('/').next().unwrap_or(file);
    if last_segment.contains('.') {
        return None;
    }
    assets
        .get(INDEX_FILE)
        .map(|index| (INDEX_FILE.to_owned(), index))
}

fn cache_policy(file: &str) -> &'static str {
    if file.starts_with(HASHED_FILES_FOLDER) {
        CACHE_FOREVER
    } else {
        CACHE_REVALIDATE
    }
}

/// The response for a found file: `304` if the client's copy is current, the file otherwise.
fn file_response(
    asset: &WebAsset,
    cache_control: &'static str,
    request_headers: &HeaderMap,
    is_head: bool,
) -> Response {
    let etag = etag_of(asset);
    let mut response = if is_client_copy_current(request_headers, &etag) {
        StatusCode::NOT_MODIFIED.into_response()
    } else {
        let body = if is_head {
            Body::empty()
        } else {
            Body::from(asset.bytes.clone())
        };
        let mut response = Response::new(body);
        if let Ok(content_type) = HeaderValue::from_str(&asset.content_type) {
            response
                .headers_mut()
                .insert(header::CONTENT_TYPE, content_type);
        }
        response
    };
    let headers = response.headers_mut();
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static(cache_control),
    );
    if let Ok(etag) = HeaderValue::from_str(&etag) {
        headers.insert(header::ETAG, etag);
    }
    response
}

/// Whether the request's `If-None-Match` names `etag` (or `*`), compared weakly as HTTP
/// requires for `If-None-Match`: `W/"x"` and `"x"` name the same content.
fn is_client_copy_current(request_headers: &HeaderMap, etag: &str) -> bool {
    let opaque = |tag: &str| tag.trim().trim_start_matches("W/").to_owned();
    let ours = opaque(etag);
    request_headers
        .get_all(header::IF_NONE_MATCH)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|tags| tags.split(','))
        .any(|tag| tag.trim() == "*" || opaque(tag) == ours)
}

/// A weak `ETag`: the content hash in hexadecimal, quoted. The compression layer sends gzip, br
/// or plain bytes under the same tag, which only a weak tag allows.
fn etag_of(asset: &WebAsset) -> String {
    let mut etag = String::from("W/\"");
    for byte in asset.sha256 {
        // Writing to a String cannot fail.
        let _ = write!(etag, "{byte:02x}");
    }
    etag.push('"');
    etag
}
