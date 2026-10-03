//! Asks the owner for the two secrets, without echoing them.
//!
//! Each answer is checked with the same validators as `binsight run`, so a file written by
//! `init` always starts. An empty password asks binsight to generate one, shown once. This module
//! talks to the terminal; it writes no file.

use binsight_api::auth::OwnerPassword;
use binsight_chain::HeliusApiKey;
use dialoguer::Password;

use crate::failure::Failure;
use crate::instance_secrets::random_bytes;
use crate::output::print_line;

/// The length of a generated password.
const GENERATED_PASSWORD_LENGTH: usize = 24;

/// The characters of a generated password: letters and digits, easy to copy.
const PASSWORD_ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/// Asks for the Helius API key until it has a valid shape.
pub(crate) fn ask_helius_api_key() -> Result<String, Failure> {
    Password::new()
        .with_prompt("Helius API key (from https://dashboard.helius.dev)")
        .validate_with(|text: &String| {
            HeliusApiKey::parse(text)
                .map(drop)
                .map_err(|error| error.to_string())
        })
        .interact()
        .map_err(|error| Failure::io("read the Helius API key", error.into()))
}

/// Asks for the password twice; an empty answer generates one and shows it once.
pub(crate) fn ask_password() -> Result<String, Failure> {
    let typed = Password::new()
        .with_prompt("Password (leave empty to generate one)")
        .with_confirmation("Repeat the password", "The passwords do not match")
        .allow_empty_password(true)
        .validate_with(|text: &String| {
            if text.is_empty() {
                return Ok(());
            }
            OwnerPassword::parse(text)
                .map(drop)
                .map_err(|error| error.to_string())
        })
        .interact()
        .map_err(|error| Failure::io("read the password", error.into()))?;
    if !typed.is_empty() {
        return Ok(typed);
    }
    let generated = generate_password()?;
    print_line(&format!("Your password is: {generated}"));
    print_line("It is shown only this once: store it in your password manager now.");
    Ok(generated)
}

/// A random password of letters and digits.
fn generate_password() -> Result<String, Failure> {
    let alphabet_size = PASSWORD_ALPHABET.len();
    // Bytes at or above the largest multiple of the alphabet size are skipped, so every
    // character is equally likely.
    let accepted_below = 256 - 256 % alphabet_size;
    let mut password = String::with_capacity(GENERATED_PASSWORD_LENGTH);
    while password.len() < GENERATED_PASSWORD_LENGTH {
        for byte in random_bytes(GENERATED_PASSWORD_LENGTH)? {
            let value = usize::from(byte);
            if value >= accepted_below || password.len() == GENERATED_PASSWORD_LENGTH {
                continue;
            }
            if let Some(&character) = PASSWORD_ALPHABET.get(value % alphabet_size) {
                password.push(char::from(character));
            }
        }
    }
    Ok(password)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generates_a_valid_password_of_letters_and_digits() {
        let password = generate_password().unwrap();

        assert_eq!(password.len(), GENERATED_PASSWORD_LENGTH);
        assert!(
            password
                .chars()
                .all(|character| character.is_ascii_alphanumeric())
        );
        assert!(OwnerPassword::parse(&password).is_ok());
        assert_ne!(password, generate_password().unwrap());
    }
}
