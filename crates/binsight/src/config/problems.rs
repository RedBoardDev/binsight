//! The settings binsight reads, where each value came from, and what can be wrong with them.
//!
//! A [`ConfigError`] lists every problem at once, so the owner fixes the configuration in one go
//! instead of one error per start. Messages name the variable and where its value came from, but
//! never repeat a secret. This module describes; it does not validate.

use std::fmt;
use std::path::PathBuf;

/// A setting of binsight and its variable.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Setting {
    /// `BINSIGHT_PASSWORD`: the owner's password.
    Password,
    /// `BINSIGHT_HELIUS_API_KEY`: the Helius API key.
    HeliusApiKey,
    /// `BINSIGHT_DATA_DIR`: where the database and its backups live.
    DataDir,
    /// `BINSIGHT_BIND`: the address and port the server listens on.
    Bind,
    /// `BINSIGHT_PUBLIC_URL`: the address the owner opens binsight at, behind a proxy.
    PublicUrl,
    /// `BINSIGHT_CLIENT_IP_HEADER`: the header a trusted proxy writes the client's address into.
    ClientIpHeader,
    /// `BINSIGHT_CONFIG_FILE`: the configuration file (environment or command line only).
    ConfigFile,
    /// `BINSIGHT_LOG`: which log events are written.
    Log,
    /// `BINSIGHT_LOG_FORMAT`: `pretty` or `json`.
    LogFormat,
}

impl Setting {
    /// Every setting, in the order they are reported.
    pub const ALL: [Self; 9] = [
        Self::Password,
        Self::HeliusApiKey,
        Self::DataDir,
        Self::Bind,
        Self::PublicUrl,
        Self::ClientIpHeader,
        Self::ConfigFile,
        Self::Log,
        Self::LogFormat,
    ];

    /// The environment variable of the setting.
    pub fn variable(self) -> &'static str {
        match self {
            Self::Password => "BINSIGHT_PASSWORD",
            Self::HeliusApiKey => "BINSIGHT_HELIUS_API_KEY",
            Self::DataDir => "BINSIGHT_DATA_DIR",
            Self::Bind => "BINSIGHT_BIND",
            Self::PublicUrl => "BINSIGHT_PUBLIC_URL",
            Self::ClientIpHeader => "BINSIGHT_CLIENT_IP_HEADER",
            Self::ConfigFile => "BINSIGHT_CONFIG_FILE",
            Self::Log => "BINSIGHT_LOG",
            Self::LogFormat => "BINSIGHT_LOG_FORMAT",
        }
    }

    /// Whether the value is a secret that must never be displayed.
    pub fn is_secret(self) -> bool {
        matches!(self, Self::Password | Self::HeliusApiKey)
    }
}

/// Where a value came from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Source {
    /// The process environment.
    Environment,
    /// The configuration file.
    File(PathBuf),
    /// The built-in default.
    Default,
}

impl fmt::Display for Source {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Environment => formatter.write_str("the environment"),
            Self::File(path) => write!(formatter, "{}", path.display()),
            Self::Default => formatter.write_str("the default"),
        }
    }
}

/// One thing wrong with the configuration.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConfigProblem {
    /// The setting at fault.
    pub setting: Setting,
    /// What is wrong, in plain words (never the secret value itself).
    pub message: String,
}

impl ConfigProblem {
    /// A problem with `setting`.
    pub fn new(setting: Setting, message: impl Into<String>) -> Self {
        Self {
            setting,
            message: message.into(),
        }
    }
}

/// The configuration cannot be used; every problem found is listed.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub struct ConfigError {
    /// What is wrong, setting by setting.
    pub problems: Vec<ConfigProblem>,
}

impl fmt::Display for ConfigError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "the configuration is invalid:")?;
        for problem in &self.problems {
            write!(
                formatter,
                "\n  - {}: {}",
                problem.setting.variable(),
                problem.message
            )?;
        }
        Ok(())
    }
}

/// Something suspicious that does not prevent binsight from starting.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConfigWarning {
    /// A `BINSIGHT_` variable binsight does not know, probably a typo.
    UnknownVariable {
        /// The unknown name.
        name: String,
        /// Where it was set.
        source: Source,
        /// The known variable it most likely meant.
        suggestion: Option<&'static str>,
    },
    /// The configuration file holds secrets but other users may read it.
    FileReadableByOthers {
        /// The file.
        path: PathBuf,
    },
}

impl fmt::Display for ConfigWarning {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::UnknownVariable {
                name,
                source,
                suggestion,
            } => {
                write!(
                    formatter,
                    "{name} (from {source}) is not a binsight setting"
                )?;
                match suggestion {
                    Some(known) => write!(formatter, "; did you mean {known}?"),
                    None => Ok(()),
                }
            }
            Self::FileReadableByOthers { path } => write!(
                formatter,
                "{} holds secrets but other users can read it; run `chmod 600` on it",
                path.display()
            ),
        }
    }
}
