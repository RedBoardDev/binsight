//! The random secrets of this installation, created on first start and kept in the database.
//!
//! The session secret signs the session cookies (together with the password); keeping it in the
//! database means sessions survive restarts and upgrades, and it travels with the backups. The
//! instance id names this installation. Both come from the operating system's secure random
//! generator. This module creates and reads them; it does not use them.

use binsight_api::auth::SessionSecret;
use binsight_store::{MetaKey, Store};

use crate::failure::Failure;

/// The length of the session secret, in bytes.
const SESSION_SECRET_BYTES: usize = 32;

/// The length of the instance id, in bytes.
const INSTANCE_ID_BYTES: usize = 16;

/// Creates the instance secrets that do not exist yet and returns the session secret.
///
/// # Errors
///
/// Returns a failure if the random generator or the database fails, or if the stored secret is
/// not 32 bytes of hexadecimal.
pub async fn ensure_instance_secrets(store: &Store) -> Result<SessionSecret, Failure> {
    let meta = store.meta();
    meta.insert_if_absent(MetaKey::InstanceId, random_hex(INSTANCE_ID_BYTES)?)
        .await?;
    meta.insert_if_absent(MetaKey::SessionSecret, random_hex(SESSION_SECRET_BYTES)?)
        .await?;
    let stored = meta.get(MetaKey::SessionSecret).await?.unwrap_or_default();
    decode_session_secret(&stored)
}

/// Replaces the session secret: every session cookie issued so far stops being valid.
///
/// # Errors
///
/// Returns a failure if the random generator or the database fails.
pub async fn rotate_session_secret(store: &Store) -> Result<(), Failure> {
    let secret = random_hex(SESSION_SECRET_BYTES)?;
    store.meta().set(MetaKey::SessionSecret, secret).await?;
    Ok(())
}

/// `length` random bytes, in hexadecimal.
pub(crate) fn random_hex(length: usize) -> Result<String, Failure> {
    random_bytes(length).map(hex::encode)
}

/// `length` bytes from the operating system's secure random generator.
pub(crate) fn random_bytes(length: usize) -> Result<Vec<u8>, Failure> {
    let mut bytes = vec![0_u8; length];
    getrandom::fill(&mut bytes).map_err(|error| {
        Failure::Unexpected(anyhow::anyhow!(
            "the system random generator failed: {error}"
        ))
    })?;
    Ok(bytes)
}

fn decode_session_secret(stored: &str) -> Result<SessionSecret, Failure> {
    let mut bytes = [0_u8; SESSION_SECRET_BYTES];
    hex::decode_to_slice(stored, &mut bytes).map_err(|error| {
        Failure::Unexpected(anyhow::anyhow!(
            "the session secret stored in the database is damaged ({error}); \
             run `binsight admin rotate-sessions` to replace it"
        ))
    })?;
    Ok(SessionSecret::from_bytes(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn draws_different_secrets_each_time() {
        let first = random_hex(SESSION_SECRET_BYTES).unwrap();
        let second = random_hex(SESSION_SECRET_BYTES).unwrap();
        assert_eq!(first.len(), 64);
        assert_ne!(first, second);
    }

    #[test]
    fn refuses_a_damaged_stored_secret() {
        assert!(decode_session_secret("not hex").is_err());
        assert!(decode_session_secret("abcd").is_err());
        assert!(decode_session_secret(&"ab".repeat(32)).is_ok());
    }
}
