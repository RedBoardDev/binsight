//! What authentication needs from the configuration, and the key that signs session cookies.
//!
//! The signing key is derived from two things: the instance's random session secret (stored in
//! the database, so sessions survive restarts and upgrades) and the owner's password. Changing the
//! password therefore changes the key and signs everyone out, without any session table; so does
//! regenerating the secret. This module holds the settings and derives the key.

use std::fmt;

use axum_extra::extract::cookie::Key;
use hmac::{Hmac, KeyInit, Mac};
use sha2::Sha256;

use super::client_address::ClientIpHeader;
use super::password::OwnerPassword;
use super::public_url::PublicUrl;

type HmacSha256 = Hmac<Sha256>;

/// The labels that make the two halves of the key independent of each other.
const ENCRYPTION_KEY_LABEL: &[u8] = b"binsight-session-enc-v1";
const SIGNING_KEY_LABEL: &[u8] = b"binsight-session-sig-v1";

/// The instance's random session secret: 32 bytes generated once and kept in the database.
#[derive(Clone)]
pub struct SessionSecret([u8; 32]);

impl SessionSecret {
    /// A secret made of these random bytes.
    pub fn from_bytes(bytes: [u8; 32]) -> Self {
        Self(bytes)
    }
}

impl fmt::Debug for SessionSecret {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("SessionSecret([REDACTED])")
    }
}

/// The authentication settings of the API.
#[derive(Debug, Clone)]
pub struct AuthSettings {
    /// The owner's password.
    pub password: OwnerPassword,
    /// The instance's session secret.
    pub session_secret: SessionSecret,
    /// The address the owner opens binsight at, if it differs from the listening address.
    pub public_url: Option<PublicUrl>,
    /// The header a trusted reverse proxy writes the client's address into, if any.
    pub client_ip_header: Option<ClientIpHeader>,
}

impl AuthSettings {
    /// The key that signs session cookies, derived from the secret and the password.
    pub(crate) fn cookie_key(&self) -> Key {
        let encryption = labelled_mac(&self.session_secret, ENCRYPTION_KEY_LABEL, &self.password);
        let signing = labelled_mac(&self.session_secret, SIGNING_KEY_LABEL, &self.password);
        let mut material = [0_u8; 64];
        let (first_half, second_half) = material.split_at_mut(32);
        first_half.copy_from_slice(&encryption);
        second_half.copy_from_slice(&signing);
        // Cannot panic: `Key::from` only requires at least 64 bytes, and `material` has 64.
        Key::from(&material)
    }

    /// Whether the session cookie must only travel over HTTPS.
    pub(crate) fn is_cookie_secure(&self) -> bool {
        self.public_url.as_ref().is_some_and(PublicUrl::is_https)
    }
}

/// `HMAC-SHA256(secret, label ‖ password)`.
fn labelled_mac(secret: &SessionSecret, label: &[u8], password: &OwnerPassword) -> [u8; 32] {
    let mut mac = HmacSha256::new(&padded_key(secret));
    mac.update(label);
    mac.update(password.expose_secret().as_bytes());
    mac.finalize().into_bytes().into()
}

/// The secret as an HMAC key block. HMAC pads a short key with zeros up to the block size, so
/// this is the same key as the 32 raw bytes, through the constructor that cannot fail.
fn padded_key(secret: &SessionSecret) -> hmac::digest::Key<HmacSha256> {
    let mut block = [0_u8; 64];
    let (start, _) = block.split_at_mut(32);
    start.copy_from_slice(&secret.0);
    block.into()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn settings(password: &str, secret_byte: u8) -> AuthSettings {
        AuthSettings {
            password: OwnerPassword::parse(password).unwrap(),
            session_secret: SessionSecret::from_bytes([secret_byte; 32]),
            public_url: None,
            client_ip_header: None,
        }
    }

    #[test]
    fn pads_the_secret_exactly_as_hmac_does_for_a_short_key() {
        let secret = SessionSecret::from_bytes([7; 32]);
        let mut padded = HmacSha256::new(&padded_key(&secret));
        let mut reference = HmacSha256::new_from_slice(&[7; 32]).unwrap();
        padded.update(b"same input");
        reference.update(b"same input");

        assert_eq!(
            padded.finalize().into_bytes(),
            reference.finalize().into_bytes()
        );
    }

    #[test]
    fn derives_the_same_key_from_the_same_settings() {
        let first = settings("correct horse battery", 1).cookie_key();
        let second = settings("correct horse battery", 1).cookie_key();
        assert_eq!(first.master(), second.master());
    }

    #[test]
    fn derives_another_key_when_the_password_or_the_secret_changes() {
        let key = settings("correct horse battery", 1).cookie_key();
        assert_ne!(
            key.master(),
            settings("another long password", 1).cookie_key().master()
        );
        assert_ne!(
            key.master(),
            settings("correct horse battery", 2).cookie_key().master()
        );
    }

    #[test]
    fn marks_the_cookie_secure_only_behind_https() {
        let mut auth = settings("correct horse battery", 1);
        assert!(!auth.is_cookie_secure());
        auth.public_url = Some(PublicUrl::parse("https://binsight.example.com").unwrap());
        assert!(auth.is_cookie_secure());
    }
}
