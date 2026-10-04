//! Reads the raw configuration: the process environment and the `binsight.env` file.
//!
//! This is the only place that reads environment variables, and it reads them once. Values are
//! kept as text, with the file they came from; nothing is validated here. The process environment
//! is never modified.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use super::env_file::parse_env_file;
use super::paths::default_config_file;
use super::problems::{ConfigProblem, Setting};

/// The environment variable that names the configuration file.
pub(crate) const CONFIG_FILE_VARIABLE: &str = "BINSIGHT_CONFIG_FILE";

/// Every variable binsight reads starts with this.
pub(crate) const VARIABLE_PREFIX: &str = "BINSIGHT_";

/// The variables outside the `BINSIGHT_` family that locate the default folders.
const FOLDER_VARIABLES: [&str; 3] = ["HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME"];

/// The raw configuration, before validation.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ConfigSources {
    /// The relevant environment variables (`BINSIGHT_*` and the folder variables).
    pub env: BTreeMap<String, String>,
    /// The configuration file, if one was found.
    pub file: Option<ConfigFile>,
}

/// A configuration file and what it sets.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConfigFile {
    /// Where it is.
    pub path: PathBuf,
    /// The variables it sets.
    pub values: BTreeMap<String, String>,
    /// Whether users other than its owner may read it (it holds secrets).
    pub is_readable_by_others: bool,
}

/// Reads the environment and the configuration file.
///
/// The file is `config_file_flag` if given, else `BINSIGHT_CONFIG_FILE`, else the default path.
/// A missing file is normal at the default path and an error anywhere else.
///
/// # Errors
///
/// Returns the problems found while locating or reading the file.
pub fn read_sources(config_file_flag: Option<&Path>) -> Result<ConfigSources, Vec<ConfigProblem>> {
    let env = read_environment();
    let explicit_path = config_file_flag
        .map(Path::to_path_buf)
        .or_else(|| env.get(CONFIG_FILE_VARIABLE).map(PathBuf::from));
    let file = match explicit_path {
        Some(path) if !path.exists() => {
            return Err(vec![ConfigProblem::new(
                Setting::ConfigFile,
                format!("the configuration file {} does not exist", path.display()),
            )]);
        }
        Some(path) => Some(read_env_file(&path)?),
        None => match default_config_file(&env) {
            Some(path) if path.exists() => Some(read_env_file(&path)?),
            _ => None,
        },
    };
    Ok(ConfigSources { env, file })
}

/// Where the configuration file is (or would be): `config_file_flag`, else
/// `BINSIGHT_CONFIG_FILE`, else the default path. `None` only when no home folder is known.
pub fn config_file_path(config_file_flag: Option<&Path>) -> Option<PathBuf> {
    let env = read_environment();
    config_file_flag
        .map(Path::to_path_buf)
        .or_else(|| env.get(CONFIG_FILE_VARIABLE).map(PathBuf::from))
        .or_else(|| default_config_file(&env))
}

/// The `BINSIGHT_*` and folder variables of this process. Variables whose name or value is not
/// valid UTF-8 are skipped (none of ours can be).
#[expect(
    clippy::disallowed_methods,
    reason = "this is the one place that reads the environment"
)]
fn read_environment() -> BTreeMap<String, String> {
    std::env::vars_os()
        .filter_map(|(name, value)| Some((name.into_string().ok()?, value.into_string().ok()?)))
        .filter(|(name, _)| {
            name.starts_with(VARIABLE_PREFIX) || FOLDER_VARIABLES.contains(&name.as_str())
        })
        .collect()
}

/// Reads a file of `NAME=value` lines (comments, quotes and `export` are understood; values are
/// taken literally, with no `$` substitution).
///
/// # Errors
///
/// Returns a problem if the file cannot be read or a line cannot be parsed.
pub fn read_env_file(path: &Path) -> Result<ConfigFile, Vec<ConfigProblem>> {
    let problem = |detail: String| {
        vec![ConfigProblem::new(
            Setting::ConfigFile,
            format!(
                "could not read the configuration file {}: {detail}",
                path.display()
            ),
        )]
    };
    let text = std::fs::read_to_string(path).map_err(|error| problem(error.to_string()))?;
    let values = parse_env_file(&text).map_err(|error| problem(error.to_string()))?;
    Ok(ConfigFile {
        path: path.to_path_buf(),
        values,
        is_readable_by_others: is_readable_by_others(path),
    })
}

#[cfg(unix)]
fn is_readable_by_others(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path).is_ok_and(|metadata| metadata.permissions().mode() & 0o044 != 0)
}

#[cfg(not(unix))]
fn is_readable_by_others(_path: &Path) -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn takes_a_password_with_dollar_signs_literally() {
        let folder = tempfile::tempdir().unwrap();
        let path = folder.path().join("binsight.env");
        std::fs::write(
            &path,
            "BINSIGHT_PASSWORD=pa$$word-$HOME\nBINSIGHT_HELIUS_API_KEY=\"key-${PATH}\"\n",
        )
        .unwrap();

        let file = read_env_file(&path).unwrap();

        assert_eq!(file.values["BINSIGHT_PASSWORD"], "pa$$word-$HOME");
        assert_eq!(file.values["BINSIGHT_HELIUS_API_KEY"], "key-${PATH}");
    }

    #[test]
    fn names_the_line_it_cannot_read() {
        let folder = tempfile::tempdir().unwrap();
        let path = folder.path().join("binsight.env");
        std::fs::write(&path, "BINSIGHT_LOG=info\nBINSIGHT_PASSWORD=two words\n").unwrap();

        let problems = read_env_file(&path).unwrap_err();

        assert!(problems[0].message.contains("line 2"), "{:?}", problems[0]);
    }

    #[test]
    fn reads_comments_quotes_and_exports_from_the_file() {
        let folder = tempfile::tempdir().unwrap();
        let path = folder.path().join("binsight.env");
        std::fs::write(
            &path,
            "# a comment\nBINSIGHT_PASSWORD=\"with spaces and # hash\"\n\nexport BINSIGHT_BIND='127.0.0.1:9000'\nBINSIGHT_LOG=debug # trailing comment\n",
        )
        .unwrap();

        let file = read_env_file(&path).unwrap();

        assert_eq!(file.values["BINSIGHT_PASSWORD"], "with spaces and # hash");
        assert_eq!(file.values["BINSIGHT_BIND"], "127.0.0.1:9000");
        assert_eq!(file.values["BINSIGHT_LOG"], "debug");
    }

    #[cfg(unix)]
    #[test]
    fn notices_a_file_other_users_can_read() {
        use std::os::unix::fs::PermissionsExt;

        let folder = tempfile::tempdir().unwrap();
        let path = folder.path().join("binsight.env");
        std::fs::write(&path, "BINSIGHT_BIND=127.0.0.1:9000\n").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        assert!(!read_env_file(&path).unwrap().is_readable_by_others);

        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o620)).unwrap();
        assert!(!read_env_file(&path).unwrap().is_readable_by_others);

        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o640)).unwrap();
        assert!(read_env_file(&path).unwrap().is_readable_by_others);

        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert!(read_env_file(&path).unwrap().is_readable_by_others);
    }

    #[test]
    fn refuses_an_explicit_file_that_does_not_exist() {
        let folder = tempfile::tempdir().unwrap();

        let problems = read_sources(Some(&folder.path().join("missing.env"))).unwrap_err();

        assert_eq!(problems[0].setting, Setting::ConfigFile);
    }
}
