//! A token logo image binsight serves itself.

use std::sync::Arc;

/// The bytes of a raster token logo and their media type.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TokenLogoImage {
    /// The media type: `image/png`, `image/jpeg`, `image/webp` or `image/gif`.
    pub content_type: &'static str,
    /// The image.
    pub bytes: Arc<[u8]>,
}
