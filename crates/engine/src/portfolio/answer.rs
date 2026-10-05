//! The future every read of the portfolio returns.
//!
//! Reads are asynchronous because the engine will read its state from disk; the demo answers
//! from memory at once. The future is boxed, like the transport futures of the chain client, so
//! the read traits stay usable as trait objects without an extra macro crate.

use std::pin::Pin;

use super::read_error::ReadError;

/// The answer to a read: a boxed future of the view or of the reason it failed.
pub type Answer<'a, T> = Pin<Box<dyn Future<Output = Result<T, ReadError>> + Send + 'a>>;

/// An answer that is already known.
pub fn answered<'a, T: Send + 'a>(result: Result<T, ReadError>) -> Answer<'a, T> {
    Box::pin(std::future::ready(result))
}
