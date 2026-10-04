//! Validating the configuration: precedence, provenance, defaults and error reports.

#![allow(clippy::unwrap_used, clippy::expect_used, reason = "tests fail loudly")]

use std::collections::BTreeMap;
use std::path::PathBuf;

use binsight::config::{ConfigFile, ConfigSources, ConfigWarning, Setting, Source, validate};

const PASSWORD: &str = "correct horse battery staple";
const KEY: &str = "1b2c3d4e-5f60-4a1b-8c2d-3e4f5a6b7c8d";

fn values(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
    pairs
        .iter()
        .map(|(name, value)| ((*name).to_owned(), (*value).to_owned()))
        .collect()
}

fn sources(env: &[(&str, &str)], file: Option<&[(&str, &str)]>) -> ConfigSources {
    ConfigSources {
        env: values(env),
        file: file.map(|pairs| ConfigFile {
            path: PathBuf::from("/etc/binsight/binsight.env"),
            values: values(pairs),
            is_readable_by_others: false,
        }),
    }
}

#[test]
fn starts_with_only_the_two_secrets_and_a_home_folder() {
    let loaded = validate(&sources(
        &[
            ("HOME", "/home/owner"),
            ("BINSIGHT_PASSWORD", PASSWORD),
            ("BINSIGHT_HELIUS_API_KEY", KEY),
        ],
        None,
    ))
    .unwrap();

    let config = loaded.config;
    assert_eq!(
        config.data_dir,
        PathBuf::from("/home/owner/.local/share/binsight")
    );
    assert_eq!(config.bind.to_string(), "127.0.0.1:8080");
    assert!(config.public_url.is_none());
    assert!(config.client_ip_header.is_none());
    assert_eq!(config.origins[&Setting::Password], Source::Environment);
    assert_eq!(config.origins[&Setting::Bind], Source::Default);
    assert_eq!(loaded.warnings, Vec::new());
}

#[test]
fn prefers_the_environment_over_the_file_over_the_default() {
    let loaded = validate(&sources(
        &[("HOME", "/home/owner"), ("BINSIGHT_BIND", "0.0.0.0:9000")],
        Some(&[
            ("BINSIGHT_PASSWORD", PASSWORD),
            ("BINSIGHT_HELIUS_API_KEY", KEY),
            ("BINSIGHT_BIND", "127.0.0.1:7000"),
            ("BINSIGHT_DATA_DIR", "~/binsight-data"),
        ]),
    ))
    .unwrap();

    let config = loaded.config;
    assert_eq!(config.bind.to_string(), "0.0.0.0:9000");
    assert_eq!(config.origins[&Setting::Bind], Source::Environment);
    assert_eq!(config.data_dir, PathBuf::from("/home/owner/binsight-data"));
    assert_eq!(
        config.origins[&Setting::Password],
        Source::File(PathBuf::from("/etc/binsight/binsight.env"))
    );
    assert_eq!(
        config.config_file,
        Some(PathBuf::from("/etc/binsight/binsight.env"))
    );
}

#[test]
fn treats_an_empty_value_as_unset() {
    let loaded = validate(&sources(
        &[
            ("HOME", "/home/owner"),
            ("BINSIGHT_PASSWORD", PASSWORD),
            ("BINSIGHT_HELIUS_API_KEY", KEY),
            ("BINSIGHT_PUBLIC_URL", ""),
        ],
        None,
    ))
    .unwrap();

    assert!(loaded.config.public_url.is_none());
}

#[test]
fn reads_the_client_address_header_of_a_trusted_proxy() {
    let loaded = validate(&sources(
        &[
            ("HOME", "/home/owner"),
            ("BINSIGHT_PASSWORD", PASSWORD),
            ("BINSIGHT_HELIUS_API_KEY", KEY),
            ("BINSIGHT_CLIENT_IP_HEADER", "X-Real-IP"),
        ],
        None,
    ))
    .unwrap();

    let header = loaded.config.client_ip_header.unwrap();
    assert_eq!(header.to_string(), "x-real-ip");
}

#[test]
fn reports_every_problem_at_once() {
    let error = validate(&sources(
        &[
            ("BINSIGHT_PASSWORD", "too short"),
            ("BINSIGHT_BIND", "localhost"),
            ("BINSIGHT_DATA_DIR", "relative/data"),
            ("BINSIGHT_PUBLIC_URL", "binsight.example.com"),
            ("BINSIGHT_CLIENT_IP_HEADER", "X Forwarded For"),
        ],
        None,
    ))
    .unwrap_err();

    insta::assert_snapshot!(error.to_string(), @r#"
    the configuration is invalid:
      - BINSIGHT_PASSWORD: the password must be at least 12 characters long (set in the environment)
      - BINSIGHT_HELIUS_API_KEY: required; set it in the environment or in the configuration file
      - BINSIGHT_DATA_DIR: relative/data is not an absolute path (set in the environment)
      - BINSIGHT_BIND: invalid socket address syntax (set in the environment)
      - BINSIGHT_PUBLIC_URL: the public URL must start with http:// or https:// (set in the environment)
      - BINSIGHT_CLIENT_IP_HEADER: "X Forwarded For" is not a valid HTTP header name, such as X-Forwarded-For (set in the environment)
    "#);
}

#[test]
fn never_repeats_a_secret_in_an_error() {
    let error = validate(&sources(
        &[
            ("HOME", "/h"),
            ("BINSIGHT_PASSWORD", "hunter2"),
            ("BINSIGHT_HELIUS_API_KEY", "bad key!"),
        ],
        None,
    ))
    .unwrap_err();

    let report = error.to_string();
    assert!(!report.contains("hunter2"), "{report}");
    assert!(!report.contains("bad key!"), "{report}");
}

#[test]
fn needs_a_data_folder_when_there_is_no_home_folder() {
    let error = validate(&sources(
        &[
            ("BINSIGHT_PASSWORD", PASSWORD),
            ("BINSIGHT_HELIUS_API_KEY", KEY),
        ],
        None,
    ))
    .unwrap_err();

    assert_eq!(error.problems.len(), 1);
    assert_eq!(error.problems[0].setting, Setting::DataDir);
}

#[test]
fn warns_about_a_misspelt_variable_and_suggests_the_right_one() {
    let loaded = validate(&sources(
        &[
            ("HOME", "/home/owner"),
            ("BINSIGHT_PASSWORD", PASSWORD),
            ("BINSIGHT_HELIUS_API_KEY", KEY),
            ("BINSIGHT_PUBLIK_URL", "https://binsight.example.com"),
        ],
        None,
    ))
    .unwrap();

    assert_eq!(
        loaded.warnings,
        vec![ConfigWarning::UnknownVariable {
            name: "BINSIGHT_PUBLIK_URL".to_owned(),
            source: Source::Environment,
            suggestion: Some("BINSIGHT_PUBLIC_URL"),
        }]
    );
    assert_eq!(
        loaded.warnings[0].to_string(),
        "BINSIGHT_PUBLIK_URL (from the environment) is not a binsight setting; did you mean \
         BINSIGHT_PUBLIC_URL?"
    );
}

#[test]
fn warns_when_other_users_can_read_the_file() {
    let mut raw = sources(
        &[("HOME", "/home/owner")],
        Some(&[
            ("BINSIGHT_PASSWORD", PASSWORD),
            ("BINSIGHT_HELIUS_API_KEY", KEY),
        ]),
    );
    if let Some(file) = raw.file.as_mut() {
        file.is_readable_by_others = true;
    }

    let loaded = validate(&raw).unwrap();

    assert!(matches!(
        loaded.warnings[0],
        ConfigWarning::FileReadableByOthers { .. }
    ));
}

#[test]
fn logs_at_info_in_the_readable_format_by_default() {
    let loaded = validate(&sources(
        &[
            ("HOME", "/home/owner"),
            ("BINSIGHT_PASSWORD", PASSWORD),
            ("BINSIGHT_HELIUS_API_KEY", KEY),
        ],
        None,
    ))
    .unwrap();

    assert_eq!(loaded.config.log.filter, "info");
    assert_eq!(
        loaded.config.log.format,
        binsight::logging::LogFormat::Pretty
    );
}

#[test]
fn refuses_an_unknown_log_format() {
    let error = validate(&sources(
        &[
            ("HOME", "/home/owner"),
            ("BINSIGHT_PASSWORD", PASSWORD),
            ("BINSIGHT_HELIUS_API_KEY", KEY),
            ("BINSIGHT_LOG_FORMAT", "xml"),
        ],
        None,
    ))
    .unwrap_err();

    assert_eq!(error.problems[0].setting, Setting::LogFormat);
}

#[test]
fn starts_in_demo_mode_without_a_helius_key() {
    let loaded = validate(&sources(
        &[
            ("HOME", "/home/owner"),
            ("BINSIGHT_PASSWORD", PASSWORD),
            ("BINSIGHT_DEMO", "true"),
        ],
        None,
    ))
    .unwrap();

    assert!(matches!(
        loaded.config.data_source,
        binsight::config::DataSourceConfig::Demo
    ));
    assert_eq!(loaded.warnings, Vec::new());
}

#[test]
fn warns_that_the_helius_key_is_ignored_in_demo_mode() {
    let loaded = validate(&sources(
        &[
            ("HOME", "/home/owner"),
            ("BINSIGHT_PASSWORD", PASSWORD),
            ("BINSIGHT_HELIUS_API_KEY", KEY),
            ("BINSIGHT_DEMO", "true"),
        ],
        None,
    ))
    .unwrap();

    let messages: Vec<String> = loaded.warnings.iter().map(ToString::to_string).collect();
    assert_eq!(
        messages,
        [
            "BINSIGHT_HELIUS_API_KEY is ignored: demo mode serves generated figures and tracks nothing"
        ]
    );
}

#[test]
fn refuses_a_demo_switch_other_than_true_or_false() {
    let error = validate(&sources(
        &[
            ("HOME", "/home/owner"),
            ("BINSIGHT_PASSWORD", PASSWORD),
            ("BINSIGHT_DEMO", "yes"),
        ],
        None,
    ))
    .unwrap_err();

    insta::assert_snapshot!(error.to_string(), @r"
    the configuration is invalid:
      - BINSIGHT_DEMO: expected true or false (set in the environment)
    ");
}
