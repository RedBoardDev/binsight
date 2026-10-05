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

use binsight_api::auth::{ClientIpHeader, OwnerPassword, PublicUrl};
use binsight_chain::HeliusApiKey;

use super::credit_budget::CreditBudget;
use super::data_source::{DataSourceConfig, parse_switch};
use super::paths::{default_data_dir, default_demo_data_dir, expand_home};
use super::problems::{ConfigError, ConfigProblem, ConfigWarning, Setting, Source};
use super::sources::{ConfigSources, VARIABLE_PREFIX};
use super::suggestion::closest_variable;
use crate::logging::{
    DEFAULT_LOG_FILTER, DEFAULT_LOG_FORMAT, LogFormat, LogSettings, parse_filter,
};

/// Where the server listens when nothing else is configured: this machine only.
pub const DEFAULT_BIND: &str = "127.0.0.1:8080";

/// The validated configuration.
#[derive(Debug, Clone)]
pub struct Config {
    /// The owner's password.
    pub password: OwnerPassword,
    /// Where the figures come from (and the Helius key in chain mode).
    pub data_source: DataSourceConfig,
    /// How the provider's credits may be spent.
    pub credit_budget: CreditBudget,
    /// Where the database and its backups live (absolute).
    pub data_dir: PathBuf,
    /// The address and port the server listens on.
    pub bind: SocketAddr,
    /// The address the owner opens binsight at, if it differs from `bind`.
    pub public_url: Option<PublicUrl>,
    /// The header a trusted reverse proxy writes the client's address into, if any.
    pub client_ip_header: Option<ClientIpHeader>,
    /// What is logged and how.
    pub log: LogSettings,
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
    let data_source = reader.data_source();
    let credit_budget = reader.credit_budget();
    let data_dir = reader.data_dir(data_source.as_ref());
    let bind = reader.with_default(Setting::Bind, DEFAULT_BIND, str::parse::<SocketAddr>);
    let public_url = reader.optional(Setting::PublicUrl, PublicUrl::parse);
    let client_ip_header = reader.optional(Setting::ClientIpHeader, ClientIpHeader::parse);
    let log_filter = reader.with_default(Setting::Log, DEFAULT_LOG_FILTER, parse_filter);
    let log_format = reader.with_default(Setting::LogFormat, DEFAULT_LOG_FORMAT, LogFormat::parse);
    match (
        (password, data_source, credit_budget),
        (data_dir, bind),
        (log_filter, log_format),
    ) {
        (
            (Some(password), Some(data_source), Some(credit_budget)),
            (Some(data_dir), Some(bind)),
            (Some(filter), Some(format)),
        ) if reader.problems.is_empty() => Ok(LoadedConfig {
            warnings: warnings(sources, &data_source),
            config: Config {
                password,
                data_source,
                credit_budget,
                data_dir,
                bind,
                public_url,
                client_ip_header,
                log: LogSettings { filter, format },
                config_file: sources.file.as_ref().map(|file| file.path.clone()),
                origins: reader.origins,
            },
        }),
        _ => Err(ConfigError {
            problems: reader.problems,
        }),
    }
}

/// Looks values up (environment first, then file) and records origins and problems.
///
/// A value that fails to parse is recorded as a problem and read as `None`, so validation goes on
/// and reports every problem; the caller checks `problems` at the end.
pub(super) struct SettingReader<'sources> {
    sources: &'sources ConfigSources,
    pub(super) origins: BTreeMap<Setting, Source>,
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
    pub(super) fn find(&self, setting: Setting) -> Option<(&'sources str, Source)> {
        let name = setting.variable();
        if let Some(value) = self.sources.env.get(name).filter(|value| !value.is_empty()) {
            return Some((value, Source::Environment));
        }
        let file = self.sources.file.as_ref()?;
        let value = file.values.get(name).filter(|value| !value.is_empty())?;
        Some((value, Source::File(file.path.clone())))
    }

    /// The parsed value of `setting`, or `None` if it is unset or invalid.
    pub(super) fn optional<T, E: Display>(
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
    pub(super) fn with_default<T, E: Display>(
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

    /// Demo mode, or chain mode with its required Helius key.
    fn data_source(&mut self) -> Option<DataSourceConfig> {
        if self.with_default(Setting::Demo, "false", parse_switch)? {
            return Some(DataSourceConfig::Demo);
        }
        let helius_api_key = self.required(Setting::HeliusApiKey, HeliusApiKey::parse)?;
        Some(DataSourceConfig::Chain { helius_api_key })
    }

    /// The data folder: configured (with `~` expanded) or the default, and absolute. Demo mode
    /// defaults to a folder of its own, so it never opens the folder of a real instance.
    fn data_dir(&mut self, data_source: Option<&DataSourceConfig>) -> Option<PathBuf> {
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
        let default = match data_source {
            Some(DataSourceConfig::Demo) => default_demo_data_dir(env),
            _ => default_data_dir(env),
        };
        let Some(default) = default else {
            let message = "no default is possible because HOME is not set; set it explicitly";
            self.problems
                .push(ConfigProblem::new(Setting::DataDir, message));
            return None;
        };
        self.origins.insert(Setting::DataDir, Source::Default);
        Some(default)
    }
}

/// Unknown `BINSIGHT_` variables (with a suggestion), settings demo mode ignores, and a
/// configuration file others can read.
fn warnings(sources: &ConfigSources, data_source: &DataSourceConfig) -> Vec<ConfigWarning> {
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
    let key_is_set = SettingReader::new(sources)
        .find(Setting::HeliusApiKey)
        .is_some();
    if matches!(data_source, DataSourceConfig::Demo) && key_is_set {
        found.push(ConfigWarning::IgnoredInDemo {
            setting: Setting::HeliusApiKey,
        });
    }
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
