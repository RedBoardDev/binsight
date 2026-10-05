//! Account field readers with explicit offsets and checked bounds.

use binsight_solana::{ByteReader, error::MalformedBytes};

use super::AccountError;

pub(super) fn reader_at(bytes: &[u8], offset: usize) -> Result<ByteReader<'_>, AccountError> {
    let mut reader = ByteReader::new(bytes);
    reader.read_bytes(offset, "account field offset")?;
    Ok(reader)
}

pub(super) fn require_length(bytes: &[u8], length: usize) -> Result<(), AccountError> {
    ByteReader::new(bytes).read_bytes(length, "complete account layout")?;
    Ok(())
}

pub(super) fn check_discriminator(
    bytes: &[u8],
    expected: [u8; 8],
    account: &'static str,
) -> Result<(), AccountError> {
    let discriminator = ByteReader::new(bytes).read_array("account discriminator")?;
    if discriminator != expected {
        return Err(AccountError::UnknownDiscriminator {
            account,
            discriminator,
        });
    }
    Ok(())
}

pub(super) fn offset_of(start: usize, index: usize, size: usize) -> Result<usize, AccountError> {
    index
        .checked_mul(size)
        .and_then(|offset| start.checked_add(offset))
        .ok_or_else(|| {
            MalformedBytes::TooLarge {
                what: "account bin offset",
            }
            .into()
        })
}
