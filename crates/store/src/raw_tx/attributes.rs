//! The labelled attributes of a raw transaction and their text form in the `raw_tx` table.
//!
//! Each attribute is an enum in Rust and a short lowercase string in SQL (the schema checks the
//! allowed strings). This module only converts between the two.

use crate::error::StoreError;

/// The transaction format version, as reported by the node.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TxVersion {
    /// A legacy transaction (no version byte).
    Legacy,
    /// A versioned transaction (`0`, `1`, ...).
    Versioned(u8),
}

/// How final the transaction was when it was fetched.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Commitment {
    /// Voted on by a supermajority, not yet rooted.
    Confirmed,
    /// Rooted: it can no longer be rolled back.
    Finalized,
}

/// The RPC encoding that was requested for the payload.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PayloadEncoding {
    /// `json`.
    Json,
    /// `jsonParsed`.
    JsonParsed,
    /// `base64`.
    Base64,
}

/// How the stored payload bytes are compressed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PayloadCompression {
    /// Stored as received.
    None,
    /// Compressed with zstd.
    Zstd,
}

pub(super) fn tx_version_to_sql(version: TxVersion) -> String {
    match version {
        TxVersion::Legacy => "legacy".to_owned(),
        TxVersion::Versioned(number) => number.to_string(),
    }
}

pub(super) fn tx_version_from_sql(text: &str) -> Result<TxVersion, StoreError> {
    if text == "legacy" {
        return Ok(TxVersion::Legacy);
    }
    text.parse()
        .map(TxVersion::Versioned)
        .map_err(|_| invalid("transaction version", text))
}

pub(super) fn commitment_to_sql(commitment: Commitment) -> &'static str {
    match commitment {
        Commitment::Confirmed => "confirmed",
        Commitment::Finalized => "finalized",
    }
}

pub(super) fn commitment_from_sql(text: &str) -> Result<Commitment, StoreError> {
    match text {
        "confirmed" => Ok(Commitment::Confirmed),
        "finalized" => Ok(Commitment::Finalized),
        _ => Err(invalid("commitment", text)),
    }
}

pub(super) fn encoding_to_sql(encoding: PayloadEncoding) -> &'static str {
    match encoding {
        PayloadEncoding::Json => "json",
        PayloadEncoding::JsonParsed => "json_parsed",
        PayloadEncoding::Base64 => "base64",
    }
}

pub(super) fn encoding_from_sql(text: &str) -> Result<PayloadEncoding, StoreError> {
    match text {
        "json" => Ok(PayloadEncoding::Json),
        "json_parsed" => Ok(PayloadEncoding::JsonParsed),
        "base64" => Ok(PayloadEncoding::Base64),
        _ => Err(invalid("payload encoding", text)),
    }
}

pub(super) fn compression_to_sql(compression: PayloadCompression) -> &'static str {
    match compression {
        PayloadCompression::None => "none",
        PayloadCompression::Zstd => "zstd",
    }
}

pub(super) fn compression_from_sql(text: &str) -> Result<PayloadCompression, StoreError> {
    match text {
        "none" => Ok(PayloadCompression::None),
        "zstd" => Ok(PayloadCompression::Zstd),
        _ => Err(invalid("payload compression", text)),
    }
}

pub(super) fn invalid(what: &'static str, value: &str) -> StoreError {
    StoreError::InvalidStoredValue {
        what,
        value: value.to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_every_attribute_through_its_sql_text() {
        for version in [
            TxVersion::Legacy,
            TxVersion::Versioned(0),
            TxVersion::Versioned(1),
        ] {
            assert_eq!(
                tx_version_from_sql(&tx_version_to_sql(version)).unwrap(),
                version
            );
        }
        for commitment in [Commitment::Confirmed, Commitment::Finalized] {
            assert_eq!(
                commitment_from_sql(commitment_to_sql(commitment)).unwrap(),
                commitment
            );
        }
        for encoding in [
            PayloadEncoding::Json,
            PayloadEncoding::JsonParsed,
            PayloadEncoding::Base64,
        ] {
            assert_eq!(
                encoding_from_sql(encoding_to_sql(encoding)).unwrap(),
                encoding
            );
        }
        for compression in [PayloadCompression::None, PayloadCompression::Zstd] {
            assert_eq!(
                compression_from_sql(compression_to_sql(compression)).unwrap(),
                compression
            );
        }
    }

    #[test]
    fn refuses_an_unknown_sql_text() {
        assert!(tx_version_from_sql("v2").is_err());
        assert!(commitment_from_sql("processed").is_err());
        assert!(encoding_from_sql("base58").is_err());
        assert!(compression_from_sql("gzip").is_err());
    }
}
