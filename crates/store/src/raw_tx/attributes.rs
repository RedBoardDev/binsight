//! The labelled attributes of a raw transaction and their text form in the `raw_tx` table.
//!
//! Each attribute is an enum in Rust and a short lowercase string in SQL (the schema checks the
//! allowed strings). The Solana attributes (version, commitment, encoding) are defined by
//! `binsight-solana`; only the compression belongs to the store. This module only converts between
//! the enums and their SQL text.

use binsight_solana::Commitment;
use binsight_solana::transaction::{TxEncoding, TxVersion};

use crate::error::StoreError;

/// How the stored payload bytes are compressed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PayloadCompression {
    /// Stored as received.
    None,
    /// Compressed with zstd.
    Zstd,
}

pub(super) fn tx_version_to_sql(version: TxVersion) -> String {
    match version.number() {
        None => "legacy".to_owned(),
        Some(number) => number.to_string(),
    }
}

pub(super) fn tx_version_from_sql(text: &str) -> Result<TxVersion, StoreError> {
    if text == "legacy" {
        return Ok(TxVersion::Legacy);
    }
    text.parse::<u8>()
        .ok()
        .and_then(|number| TxVersion::try_from(number).ok())
        .ok_or_else(|| invalid("transaction version", text))
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

pub(super) fn encoding_to_sql(encoding: TxEncoding) -> &'static str {
    match encoding {
        TxEncoding::Json => "json",
        TxEncoding::JsonParsed => "json_parsed",
        TxEncoding::Base64 => "base64",
    }
}

pub(super) fn encoding_from_sql(text: &str) -> Result<TxEncoding, StoreError> {
    match text {
        "json" => Ok(TxEncoding::Json),
        "json_parsed" => Ok(TxEncoding::JsonParsed),
        "base64" => Ok(TxEncoding::Base64),
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
        for version in [TxVersion::Legacy, TxVersion::V0, TxVersion::V1] {
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
        for encoding in [TxEncoding::Json, TxEncoding::JsonParsed, TxEncoding::Base64] {
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
        assert!(tx_version_from_sql("2").is_err());
        assert!(commitment_from_sql("processed").is_err());
        assert!(encoding_from_sql("base58").is_err());
        assert!(compression_from_sql("gzip").is_err());
    }
}
