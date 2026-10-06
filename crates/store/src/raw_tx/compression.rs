//! Compressing a transaction payload for the registry, and reading it back intact.
//!
//! Payloads are compressed with zstd, and the SHA-256 of the uncompressed bytes is stored next to
//! them: reading a payload back checks it, so a damaged row is reported instead of decoded. This
//! module transforms bytes; it does not touch the database.

use sha2::{Digest, Sha256};

use super::attributes::PayloadCompression;
use crate::error::StoreError;

/// The zstd level: payloads are a few kilobytes, so a high level costs little time and the
/// registry keeps every transaction forever.
const ZSTD_LEVEL: i32 = 9;

/// A payload as the registry stores it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct StoredPayload {
    /// How `bytes` are compressed.
    pub(crate) compression: PayloadCompression,
    /// The stored bytes.
    pub(crate) bytes: Vec<u8>,
    /// The SHA-256 of the uncompressed payload.
    pub(crate) sha256: [u8; 32],
}

/// Compresses `payload` with zstd and records the hash of its uncompressed bytes.
pub(crate) fn compress(payload: &[u8]) -> Result<StoredPayload, StoreError> {
    let bytes = zstd::stream::encode_all(payload, ZSTD_LEVEL)
        .map_err(|source| StoreError::Compression { source })?;
    Ok(StoredPayload {
        compression: PayloadCompression::Zstd,
        bytes,
        sha256: sha256(payload),
    })
}

/// The uncompressed form of `bytes`, compressed as `compression`, once its hash is checked
/// against `expected_sha256`.
pub(crate) fn decompress_bytes(
    compression: PayloadCompression,
    bytes: &[u8],
    expected_sha256: &[u8; 32],
) -> Result<Vec<u8>, StoreError> {
    let payload = match compression {
        PayloadCompression::None => bytes.to_vec(),
        PayloadCompression::Zstd => {
            zstd::stream::decode_all(bytes).map_err(|source| StoreError::Compression { source })?
        }
    };
    if sha256(&payload) != *expected_sha256 {
        return Err(StoreError::PayloadChecksumMismatch);
    }
    Ok(payload)
}

fn sha256(bytes: &[u8]) -> [u8; 32] {
    Sha256::digest(bytes).into()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compresses_payloads_and_reads_them_back_byte_for_byte() {
        let payload =
            br#"{"slot":1,"transaction":["AQID","base64"],"meta":{"err":null}}"#.repeat(20);

        let stored = compress(&payload).unwrap();

        assert_eq!(stored.compression, PayloadCompression::Zstd);
        assert!(stored.bytes.len() < payload.len());
        assert_eq!(
            decompress_bytes(stored.compression, &stored.bytes, &stored.sha256).unwrap(),
            payload
        );
    }

    #[test]
    fn checks_the_payload_hash_of_the_uncompressed_bytes() {
        let mut stored = compress(b"{\"slot\":1}").unwrap();
        stored.sha256 = sha256(&stored.bytes);

        assert!(matches!(
            decompress_bytes(stored.compression, &stored.bytes, &stored.sha256),
            Err(StoreError::PayloadChecksumMismatch)
        ));
    }

    #[test]
    fn reads_an_uncompressed_payload_as_it_is() {
        let stored = StoredPayload {
            compression: PayloadCompression::None,
            bytes: b"{}".to_vec(),
            sha256: sha256(b"{}"),
        };

        assert_eq!(
            decompress_bytes(stored.compression, &stored.bytes, &stored.sha256).unwrap(),
            b"{}"
        );
    }
}
