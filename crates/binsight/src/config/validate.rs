//! Turns the raw configuration into typed, validated settings.
//!
//! Validation is a pure function of the raw values: it never reads the environment or the disk,
//! so every rule is tested directly. Each value is checked by the crate that owns its concept (the
//! password by the API, the Helius key by the chain client). Every problem is collected before
//! giving up, and unknown `BINSIGHT_` variables are reported as warnings.

use std::collections::BTreeMap;
use std::fmt::Display;
use std::net::SocketAddr;
use std::path::PathBuf;

use binsight_api::auth::{OwnerPassword, PublicUrl};
use binsight_chain::HeliusApiKey;

use super::paths::{default_data_dir, expand_home};
use super::problems::{ConfigError, ConfigProblem, ConfigWarning, Setting, Source};
use super::sources::{ConfigSources, VARIABLE_PREFIX};
use super::suggestion::closest_variable;

/// Where the server listens when nothing else is configured: this machine only.
pub const DEFAULT_BIND: &str = "127.0.0.1:8080";

/// The validated configuration.
#[derive(Debug, Clone)]
pub struct Config {
    /// The owner's password.
    pub password: OwnerPassword,
    /// The Helius API key.
    pub helius_api_key: HeliusApiKey,
    /// Where the database and its backups live (absolute).
    pub data_dir: PathBuf,
    /// The address and port the server listens on.
    pub bind: SocketAddr,
    /// The address the owner opens binsight at, if it differs from `bind`.
    pub public_url: Option<PublicUrl>,
    /// The configuration file that was read, if any.
    pub config_file: Option<PathBuf>,
    /// Where each set value came from.
    pub origins: BTreeMap<Setting, Source>,
}

/// A validated configuration and the warnings to log once logging is ready.
#[derive(Debug, Clone)]
pub struct LoadedConfig {
    /// The configuration.
    pub config: Config,
    /// Suspicious but harmless findings.
    pub warnings: Vec<ConfigWarning>,
}

/// Validates every setting of `sources`.
///
/// # Errors
///
/// Returns a [`ConfigError`] listing every problem if any setting is missing or invalid.
pub fn validate(sources: &ConfigSources) -> Result<LoadedConfig, ConfigError> {
    let mut reader = SettingReader::new(sources);
    let password = reader.required(Setting::Password, OwnerPassword::parse);
    let helius_api_key = reader.required(Setting::HeliusApiKey, HeliusApiKey::parse);
    let data_dir = reader.data_dir();
    let bind = reader.with_default(Setting::Bind, DEFAULT_BIND, str::parse::<SocketAddr>);
    let public_url = reader.optional(Setting::PublicUrl, PublicUrl::parse);
    match (password, helius_api_key, data_dir, bind) {
        (Some(password), Some(helius_api_key), Some(data_dir), Some(bind))
            if reader.problems.is_empty() =>
        {
            Ok(LoadedConfig {
                config: Config {
                    password,
                    helius_api_key,
                    data_dir,
                    bind,
                    public_url,
                    config_file: sources.file.as_ref().map(|file| file.path.clone()),
                    origins: reader.origins,
                },
                warnings: warnings(sources),
            })
        }
        _ => Err(ConfigError {
            problems: reader.problems,
        }),
    }
}

/// Looks values up (environment first, then file) and records origins and problems.
///
/// A value that fails to parse is recorded as a problem and read as `None`, so validation goes on
/// and reports every problem; the caller checks `problems` at the end.
struct SettingReader<'sources> {
    sources: &'sources ConfigSources,
    origins: BTreeMap<Setting, Source>,
    problems: Vec<ConfigProblem>,
}

impl<'sources> SettingReader<'sources> {
    fn new(sources: &'sources ConfigSources) -> Self {
        Self {
            sources,
            origins: BTreeMap::new(),
            problems: Vec::new(),
        }
    }

    /// The raw value of `setting` and where it came from; an empty value counts as unset.
    fn find(&self, setting: Setting) -> Option<(&'sources str, Source)> {
        let name = setting.variable();
        if let Some(value) = self.sources.env.get(name).filter(|value| !value.is_empty()) {
            return Some((value, Source::Environment));
        }
        let file = self.sources.file.as_ref()?;
        let value = file.values.get(name).filter(|value| !value.is_empty())?;
        Some((value, Source::File(file.path.clone())))
    }

    /// The parsed value of `setting`, or `None` if it is unset or invalid.
    fn optional<T, E: Display>(
        &mut self,
        setting: Setting,
        parse: impl Fn(&str) -> Result<T, E>,
    ) -> Option<T> {
        let (text, source) = self.find(setting)?;
        match parse(text) {
            Ok(value) => {
                self.origins.insert(setting, source);
                Some(value)
            }
            Err(error) => {
                let message = format!("{error} (set in {source})");
                self.problems.push(ConfigProblem::new(setting, message));
                None
            }
        }
    }

    /// The parsed value of `setting`, which must be set.
    fn required<T, E: Display>(
        &mut self,
        setting: Setting,
        parse: impl Fn(&str) -> Result<T, E>,
    ) -> Option<T> {
        if self.find(setting).is_none() {
            let message = "required; set it in the environment or in the configuration file";
            self.problems.push(ConfigProblem::new(setting, message));
            return None;
        }
        self.optional(setting, parse)
    }

    /// The parsed value of `setting`, or `default` when it is unset.
    fn with_default<T, E: Display>(
        &mut self,
        setting: Setting,
        default: &str,
        parse: impl Fn(&str) -> Result<T, E>,
    ) -> Option<T> {
        if self.find(setting).is_some() {
            return self.optional(setting, parse);
        }
        self.origins.insert(setting, Source::Default);
        parse(default).ok()
    }

    /// The data folder: configured (with `~` expanded) or the default, and absolute.
    fn data_dir(&mut self) -> Option<PathBuf> {
        let env = &self.sources.env;
        if self.find(Setting::DataDir).is_some() {
            return self.optional(Setting::DataDir, |text| {
                let path = expand_home(text, env);
                if path.is_absolute() {
                    Ok(path)
                } else {
                    Err(format!("{} is not an absolute path", path.display()))
                }
            });
        }
        let Some(default) = default_data_dir(env) else {
            let message = "no default is possible because HOME is not set; set it explicitly";
            self.problems
                .push(ConfigProblem::new(Setting::DataDir, message));
            return None;
        };
        self.origins.insert(Setting::DataDir, Source::Default);
        Some(default)
    }
}

/// Unknown `BINSIGHT_` variables (with a suggestion) and a configuration file others can read.
fn warnings(sources: &ConfigSources) -> Vec<ConfigWarning> {
    let from_env = sources.env.keys().map(|name| (name, Source::Environment));
    let from_file = sources.file.iter().flat_map(|file| {
        file.values
            .keys()
            .map(|name| (name, Source::File(file.path.clone())))
    });
    let mut found: Vec<ConfigWarning> = from_env
        .chain(from_file)
        .filter(|(name, _)| name.starts_with(VARIABLE_PREFIX))
        .filter(|(name, _)| {
            !Setting::ALL
                .iter()
                .any(|setting| setting.variable() == *name)
        })
        .map(|(name, source)| ConfigWarning::UnknownVariable {
            name: name.clone(),
            source,
            suggestion: closest_variable(name),
        })
        .collect();
    if let Some(file) = sources
        .file
        .as_ref()
        .filter(|file| file.is_readable_by_others)
    {
        found.push(ConfigWarning::FileReadableByOthers {
            path: file.path.clone(),
        });
    }
    found
}
