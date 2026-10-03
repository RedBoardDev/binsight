//! The owner's password and how a login attempt is checked against it.
//!
//! The password comes from the configuration; nothing is stored, so a slow hash would protect
//! nothing. An attempt is compared through SHA-256 digests in constant time, so neither the
//! content nor the length of the password leaks through timing. This module validates and
//! compares; it does not count attempts.

use std::fmt;

use secrecy::{ExposeSecret, SecretString};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;

/// The owner's password, at least [`OwnerPassword::MIN_CHARACTERS`] characters long.
#[derive(Clone)]
pub struct OwnerPassword {
    secret: SecretString,
    digest: [u8; 32],
}

/// Why a text cannot be the owner's password. Errors never contain the password.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum PasswordError {
    /// The password is too short to resist guessing.
    #[error("the password must be at least {min} characters long")]
    TooShort {
        /// The minimum length, in characters.
        min: usize,
    },
    /// The password is longer than any password manager produces.
    #[error("the password must be at most {max} characters long")]
    TooLong {
        /// The maximum length, in characters.
        max: usize,
    },
}

impl OwnerPassword {
    /// The shortest password accepted, in characters (not bytes).
    pub const MIN_CHARACTERS: usize = 12;

    /// The longest password accepted, in characters.
    pub const MAX_CHARACTERS: usize = 1024;

    /// Checks the length of `text` and keeps it as a secret.
    ///
    /// # Errors
    ///
    /// Returns a [`PasswordError`] if the password is shorter than [`Self::MIN_CHARACTERS`] or
    /// longer than [`Self::MAX_CHARACTERS`].
    pub fn parse(text: &str) -> Result<Self, PasswordError> {
        let length = text.chars().count();
        if length < Self::MIN_CHARACTERS {
            return Err(PasswordError::TooShort {
                min: Self::MIN_CHARACTERS,
            });
        }
        if length > Self::MAX_CHARACTERS {
            return Err(PasswordError::TooLong {
                max: Self::MAX_CHARACTERS,
            });
        }
        Ok(Self {
            secret: SecretString::from(text),
            digest: Sha256::digest(text.as_bytes()).into(),
        })
    }

    /// Whether `attempt` is the password, compared in constant time.
    pub(crate) fn matches(&self, attempt: &str) -> bool {
        let attempt_digest: [u8; 32] = Sha256::digest(attempt.as_bytes()).into();
        attempt_digest.ct_eq(&self.digest).into()
    }

    /// The password itself, to derive the session key from it.
    pub(crate) fn expose_secret(&self) -> &str {
        self.secret.expose_secret()
    }
}

impl fmt::Debug for OwnerPassword {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("OwnerPassword([REDACTED])")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_the_right_password_only() {
        let password = OwnerPassword::parse("correct horse battery").unwrap();

        assert!(password.matches("correct horse battery"));
        assert!(!password.matches("correct horse batter"));
        assert!(!password.matches(""));
    }

    #[test]
    fn counts_characters_rather_than_bytes() {
        assert!(OwnerPassword::parse("ééééééééééé").is_err());
        assert!(OwnerPassword::parse("éééééééééééé").is_ok());
    }

    #[test]
    fn refuses_passwords_outside_the_allowed_lengths() {
        assert_eq!(
            OwnerPassword::parse("short-pass").unwrap_err(),
            PasswordError::TooShort { min: 12 }
        );
        assert_eq!(
            OwnerPassword::parse(&"x".repeat(1025)).unwrap_err(),
            PasswordError::TooLong { max: 1024 }
        );
    }

    #[test]
    fn never_shows_the_password_in_debug_output() {
        let password = OwnerPassword::parse("correct horse battery").unwrap();
        assert_eq!(format!("{password:?}"), "OwnerPassword([REDACTED])");
    }
}
