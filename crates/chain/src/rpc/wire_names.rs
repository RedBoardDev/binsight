//! How Solana vocabulary is spelled in JSON-RPC parameters.
//!
//! The commitment and encoding enums live in `binsight-solana`, which knows nothing about the RPC
//! wire format; this module gives their parameter spelling, in one place.

use binsight_solana::Commitment;
use binsight_solana::transaction::TxEncoding;

/// The `commitment` parameter value.
pub(crate) const fn commitment_name(commitment: Commitment) -> &'static str {
    match commitment {
        Commitment::Confirmed => "confirmed",
        Commitment::Finalized => "finalized",
    }
}

/// The `encoding` parameter value.
pub(crate) const fn encoding_name(encoding: TxEncoding) -> &'static str {
    match encoding {
        TxEncoding::Json => "json",
        TxEncoding::JsonParsed => "jsonParsed",
        TxEncoding::Base64 => "base64",
    }
}
