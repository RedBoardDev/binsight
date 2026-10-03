//! The files of the web app served by the binary.
//!
//! The web build is not embedded yet: this source has no files, so the server answers the API
//! and `404` for everything else.

use binsight_api::{WebAsset, WebAssets};

/// The web app files embedded in the binary.
#[derive(Debug, Clone, Copy, Default)]
pub struct EmbeddedWebApp;

impl WebAssets for EmbeddedWebApp {
    fn get(&self, _path: &str) -> Option<WebAsset> {
        None
    }
}
