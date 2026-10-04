//! The configuration of binsight: read once, validated completely, then passed down as plain
//! typed values.
//!
//! Values come from environment variables (`BINSIGHT_*`), then from a `binsight.env` file, then
//! from built-in defaults, in that order of precedence. No other part of binsight reads the
//! environment. Validation is pure and reports every problem at once.

mod credit_budget;
mod env_file;
mod paths;
mod problems;
mod sources;
mod suggestion;
mod validate;

use std::path::Path;

pub use credit_budget::CreditBudget;
pub use problems::{ConfigError, ConfigProblem, ConfigWarning, Setting, Source};
pub use sources::{ConfigFile, ConfigSources, config_file_path, read_env_file, read_sources};
pub use validate::{Config, DEFAULT_BIND, LoadedConfig, validate};

/// Reads and validates the configuration; `config_file_flag` is the `--config-file` option.
///
/// # Errors
///
/// Returns a [`ConfigError`] listing every problem found.
pub fn load(config_file_flag: Option<&Path>) -> Result<LoadedConfig, ConfigError> {
    let sources = read_sources(config_file_flag).map_err(|problems| ConfigError { problems })?;
    validate(&sources)
}
