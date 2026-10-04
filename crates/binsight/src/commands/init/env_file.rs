//! The content of a new `binsight.env` file, and writing it safely.
//!
//! The file sets the two secrets and lists every other setting as a comment with its default, so
//! the owner discovers them in place. Values are written single-quoted, which the `.env` parser
//! reads literally (no `$` substitution, no escapes), so any password survives the round trip. The
//! file is created readable by its owner only, in a private folder, and appears complete or not
//! at all (written to a temporary file, then renamed).

use std::fmt::Write;
use std::io::Write as _;
use std::path::Path;

use crate::config::DEFAULT_BIND;
use crate::logging::{DEFAULT_LOG_FILTER, DEFAULT_LOG_FORMAT};

/// The text of a configuration file with these secrets.
pub(crate) fn render_env_file(helius_api_key: &str, password: &str) -> String {
    let mut text = String::from(
        "# binsight configuration, written by `binsight init`.\n\
         # Environment variables override this file. Keep it private: it holds secrets.\n\n",
    );
    let _ = writeln!(text, "BINSIGHT_HELIUS_API_KEY={}", quote(helius_api_key));
    let _ = writeln!(text, "BINSIGHT_PASSWORD={}", quote(password));
    let _ = write!(
        text,
        "\n# Optional settings, shown with their defaults or an example:\n\
         # BINSIGHT_HELIUS_PLAN=free\n\
         # BINSIGHT_CREDIT_CYCLE_DAY=1\n\
         # BINSIGHT_DAILY_CREDIT_LIMIT=5000\n\
         # BINSIGHT_DATA_DIR=~/.local/share/binsight\n\
         # BINSIGHT_BIND={DEFAULT_BIND}\n\
         # BINSIGHT_PUBLIC_URL=https://binsight.example.com\n\
         # BINSIGHT_CLIENT_IP_HEADER=X-Forwarded-For\n\
         # BINSIGHT_LOG={DEFAULT_LOG_FILTER}\n\
         # BINSIGHT_LOG_FORMAT={DEFAULT_LOG_FORMAT}\n"
    );
    text
}

/// `value` in single quotes; a single quote inside becomes `'\''` (close, escaped quote, reopen).
fn quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', r"'\''"))
}

/// Writes `content` to `path` with owner-only permissions, creating private parent folders. The
/// file is replaced atomically if it exists.
pub(crate) fn write_private_file(path: &Path, content: &str) -> std::io::Result<()> {
    let folder = path.parent().unwrap_or(Path::new("."));
    crate::data_dir::create_private_folder(folder)?;
    let temporary = path.with_extension("env.partial");
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    let mut file = options.open(&temporary)?;
    file.write_all(content.as_bytes())?;
    file.sync_all()?;
    std::fs::rename(&temporary, path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::read_env_file;

    #[test]
    fn keeps_any_password_intact_through_the_env_file_parser() {
        let folder = tempfile::tempdir().unwrap();
        let path = folder.path().join("binsight.env");
        let password = r#"pa$$ "w0rd" \ # it's $HOME"#;

        write_private_file(&path, &render_env_file("key-123", password)).unwrap();

        let file = read_env_file(&path).unwrap();
        assert_eq!(file.values["BINSIGHT_PASSWORD"], password);
        assert_eq!(file.values["BINSIGHT_HELIUS_API_KEY"], "key-123");
        assert_eq!(
            file.values.len(),
            2,
            "the optional settings stay commented out"
        );
    }

    #[test]
    fn lists_the_optional_settings_with_their_defaults() {
        let text = render_env_file("key", "password");
        assert!(text.contains("# BINSIGHT_BIND=127.0.0.1:8080\n"));
        assert!(text.contains("# BINSIGHT_LOG_FORMAT=pretty\n"));
    }

    #[cfg(unix)]
    #[test]
    fn writes_a_file_only_its_owner_can_read_in_a_private_folder() {
        use std::os::unix::fs::PermissionsExt;

        let folder = tempfile::tempdir().unwrap();
        let path = folder.path().join("config/binsight/binsight.env");

        write_private_file(&path, "BINSIGHT_PASSWORD='x'\n").unwrap();

        let file_mode = std::fs::metadata(&path).unwrap().permissions().mode();
        let folder_mode = std::fs::metadata(path.parent().unwrap())
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(file_mode & 0o777, 0o600);
        assert_eq!(folder_mode & 0o777, 0o700);
        assert!(!path.with_extension("env.partial").exists());
    }
}
