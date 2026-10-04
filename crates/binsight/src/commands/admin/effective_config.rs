//! The effective configuration as lines of text, secrets hidden.
//!
//! Each line names the variable, its value (or `(set)` for a secret, `(not set)` when absent) and
//! where the value came from. This module only formats.

use crate::config::{Config, Setting};
use crate::logging::LogFormat;

/// One line per setting, in a stable order.
pub(super) fn describe(config: &Config) -> Vec<String> {
    Setting::ALL
        .into_iter()
        .map(|setting| {
            let value = displayed_value(config, setting);
            let origin = config
                .origins
                .get(&setting)
                .map_or_else(String::new, |source| format!(" (from {source})"));
            format!("{}={value}{origin}", setting.variable())
        })
        .collect()
}

fn displayed_value(config: &Config, setting: Setting) -> String {
    match setting {
        Setting::Password | Setting::HeliusApiKey => "(set)".to_owned(),
        Setting::DataDir => config.data_dir.display().to_string(),
        Setting::Bind => config.bind.to_string(),
        Setting::PublicUrl => config
            .public_url
            .as_ref()
            .map_or_else(|| "(not set)".to_owned(), ToString::to_string),
        Setting::ClientIpHeader => config
            .client_ip_header
            .as_ref()
            .map_or_else(|| "(not set)".to_owned(), ToString::to_string),
        Setting::ConfigFile => config
            .config_file
            .as_ref()
            .map_or_else(|| "(none)".to_owned(), |path| path.display().to_string()),
        Setting::Log => config.log.filter.clone(),
        Setting::LogFormat => match config.log.format {
            LogFormat::Pretty => "pretty".to_owned(),
            LogFormat::Json => "json".to_owned(),
        },
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use super::*;
    use crate::config::{ConfigSources, validate};

    #[test]
    fn hides_the_secrets_and_shows_where_values_come_from() {
        let env: BTreeMap<String, String> = [
            ("HOME", "/home/owner"),
            ("BINSIGHT_PASSWORD", "correct horse battery staple"),
            ("BINSIGHT_HELIUS_API_KEY", "secret-helius-key"),
        ]
        .into_iter()
        .map(|(name, value)| (name.to_owned(), value.to_owned()))
        .collect();
        let config = validate(&ConfigSources { env, file: None }).unwrap().config;

        let lines = describe(&config).join("\n");

        assert_eq!(
            lines,
            "BINSIGHT_PASSWORD=(set) (from the environment)\n\
             BINSIGHT_HELIUS_API_KEY=(set) (from the environment)\n\
             BINSIGHT_DATA_DIR=/home/owner/.local/share/binsight (from the default)\n\
             BINSIGHT_BIND=127.0.0.1:8080 (from the default)\n\
             BINSIGHT_PUBLIC_URL=(not set)\n\
             BINSIGHT_CLIENT_IP_HEADER=(not set)\n\
             BINSIGHT_CONFIG_FILE=(none)\n\
             BINSIGHT_LOG=info (from the default)\n\
             BINSIGHT_LOG_FORMAT=pretty (from the default)"
        );
    }
}
