//! The server shell: the router, the middleware stack, the shared state, the web app and serving
//! it all on a socket.
//!
//! This module assembles; the API's routes live in their own modules and are registered by the
//! router.

mod layers;
mod router;
mod server;
mod state;
mod web_app;

pub(crate) use layers::Transport;
pub(crate) use router::DocumentedRoutes;
pub use router::router;
pub use server::serve;
pub use state::{AppState, AppStateParts};
pub use web_app::{INDEX_FILE, WebAsset, WebAssets};
