//! Solana transactions as binsight reads them.
//!
//! For now this module only names the transaction formats and the encodings a node can return a
//! transaction in; it does not parse a transaction yet.

mod encoding;
mod version;

pub use encoding::TxEncoding;
pub use version::{MAX_SUPPORTED_TX_VERSION, TxVersion, UnsupportedTxVersion};
