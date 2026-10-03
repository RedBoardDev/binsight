//! The Helius API key, validated once and never shown.
//!
//! The key authenticates every request to Helius and lets anyone who holds it spend the owner's
//! credits, so it is kept in a [`SecretString`]: it cannot be printed by accident (`Debug` shows
//! `[REDACTED]`). This module only checks the key's shape; it never contacts Helius, so a
//! placeholder of the right shape is accepted (useful for development and tests).

use std::fmt;

use secrecy::{ExposeSecret, SecretString};

/// A Helius API key of a plausible shape.
#[derive(Clone)]
pub struct HeliusApiKey(SecretString);

/// Why a text is not a plausible Helius API key. Errors never contain the key itself.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum HeliusKeyError {
    /// The key is empty.
    #[error("the Helius API key is empty")]
    Empty,
    /// The key is longer than any Helius key.
    #[error("the Helius API key is {length} characters long; the maximum is {max}")]
    TooLong {
        /// The length found.
        length: usize,
        /// The longest key accepted.
        max: usize,
    },
    /// The key contains something other than ASCII letters, digits and dashes.
    #[error(
        "the Helius API key may only contain letters, digits and dashes (character {position} is \
         not one)"
    )]
    InvalidCharacter {
        /// The 1-based position of the first invalid character.
        position: usize,
    },
}

impl HeliusApiKey {
    /// The longest key accepted, in characters.
    pub const MAX_LENGTH: usize = 128;

    /// Checks the shape of `text` and keeps it as a secret.
    ///
    /// # Errors
    ///
    /// Returns a [`HeliusKeyError`] if the text is empty, longer than [`Self::MAX_LENGTH`] or
    /// contains anything other than ASCII letters, digits and dashes.
    pub fn parse(text: &str) -> Result<Self, HeliusKeyError> {
        if text.is_empty() {
            return Err(HeliusKeyError::Empty);
        }
        let length = text.chars().count();
        if length > Self::MAX_LENGTH {
            return Err(HeliusKeyError::TooLong {
                length,
                max: Self::MAX_LENGTH,
            });
        }
        let invalid = text
            .chars()
            .position(|character| !(character.is_ascii_alphanumeric() || character == '-'));
        if let Some(index) = invalid {
            return Err(HeliusKeyError::InvalidCharacter {
                position: index.saturating_add(1),
            });
        }
        Ok(Self(SecretString::from(text)))
    }

    /// The key itself, to put in a request. Never log it, nor a URL that contains it.
    pub fn expose_secret(&self) -> &str {
        self.0.expose_secret()
    }
}

impl fmt::Debug for HeliusApiKey {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("HeliusApiKey([REDACTED])")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_a_key_of_the_usual_shape() {
        let key = HeliusApiKey::parse("1b2c3d4e-5f60-4a1b-8c2d-3e4f5a6b7c8d").unwrap();
        assert_eq!(key.expose_secret(), "1b2c3d4e-5f60-4a1b-8c2d-3e4f5a6b7c8d");
    }

    #[test]
    fn accepts_a_placeholder_because_it_never_calls_helius() {
        assert!(HeliusApiKey::parse("e2e-placeholder-key").is_ok());
    }

    #[test]
    fn refuses_an_empty_key() {
        assert_eq!(HeliusApiKey::parse("").unwrap_err(), HeliusKeyError::Empty);
    }

    #[test]
    fn refuses_a_key_longer_than_the_maximum() {
        let longest = "a".repeat(HeliusApiKey::MAX_LENGTH);
        assert!(HeliusApiKey::parse(&longest).is_ok());

        let error = HeliusApiKey::parse(&format!("{longest}a")).unwrap_err();
        assert_eq!(
            error,
            HeliusKeyError::TooLong {
                length: 129,
                max: 128
            }
        );
    }

    #[test]
    fn refuses_spaces_and_url_characters_without_echoing_them() {
        for (text, position) in [
            (" token1", 1),
            ("token2 ", 7),
            ("tok3?api-key=x", 5),
            ("clé", 3),
        ] {
            let error = HeliusApiKey::parse(text).unwrap_err();
            assert_eq!(
                error,
                HeliusKeyError::InvalidCharacter { position },
                "{text}"
            );
            assert!(!error.to_string().contains(text));
        }
    }

    #[test]
    fn never_shows_the_key_in_debug_output() {
        let key = HeliusApiKey::parse("super-secret-key").unwrap();
        assert_eq!(format!("{key:?}"), "HeliusApiKey([REDACTED])");
    }
}
