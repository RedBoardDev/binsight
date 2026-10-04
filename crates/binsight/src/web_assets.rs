//! The files of the web app, embedded in the binary.
//!
//! The web build (`web/dist`) is embedded at compile time, so binsight stays a single file. In
//! debug builds the files are read from disk instead, so a fresh `just web-build` shows up without
//! recompiling Rust. When the binary was built without the web app, `index.html` is a small
//! placeholder page that says so. This module only provides files; serving them is the API's job.

use binsight_api::{INDEX_FILE, WebAsset, WebAssets};
use rust_embed::{EmbeddedFile, RustEmbed};

/// The web build.
#[derive(RustEmbed)]
#[folder = "../../web/dist"]
#[allow_missing = true]
struct WebBuild;

/// The page shown when the web build is missing.
#[derive(RustEmbed)]
#[folder = "assets/placeholder"]
struct Placeholder;

/// The web app files embedded in this binary.
#[derive(Debug, Clone, Copy, Default)]
pub struct EmbeddedWebApp;

impl EmbeddedWebApp {
    /// Whether this binary contains the web app (rather than the placeholder page).
    pub fn is_built(self) -> bool {
        WebBuild::get(INDEX_FILE).is_some()
    }
}

impl WebAssets for EmbeddedWebApp {
    fn get(&self, path: &str) -> Option<WebAsset> {
        if let Some(file) = WebBuild::get(path) {
            return Some(to_web_asset(file));
        }
        if path == INDEX_FILE {
            return Placeholder::get(INDEX_FILE).map(to_web_asset);
        }
        None
    }
}

/// An embedded file as the API serves it; its media type comes from its extension.
fn to_web_asset(file: EmbeddedFile) -> WebAsset {
    WebAsset {
        content_type: file.metadata.mimetype().to_owned(),
        sha256: file.metadata.sha256_hash(),
        bytes: file.data,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A few files with the names a web build produces.
    #[derive(RustEmbed)]
    #[folder = "tests/fixtures/web"]
    struct Fixture;

    #[test]
    fn always_has_an_index_page() {
        let index = EmbeddedWebApp.get(INDEX_FILE).unwrap();

        assert_eq!(index.content_type, "text/html");
        if !EmbeddedWebApp.is_built() {
            let page = String::from_utf8(index.bytes.into_owned()).unwrap();
            assert!(page.contains("binsight is running"));
        }
    }

    #[test]
    fn has_no_file_the_build_does_not_have() {
        assert_eq!(EmbeddedWebApp.get("assets/never-built.js"), None);
    }

    #[test]
    fn serves_the_manifest_and_scripts_with_their_media_types() {
        let manifest = to_web_asset(Fixture::get("manifest.webmanifest").unwrap());
        let script = to_web_asset(Fixture::get("assets/app-1a2b.js").unwrap());

        assert_eq!(manifest.content_type, "application/manifest+json");
        assert_eq!(script.content_type, "text/javascript");
    }
}
