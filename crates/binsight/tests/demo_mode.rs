//! Demo mode in the configuration: no Helius key needed, a key that is set is ignored, and the
//! clock may be frozen for reproducible screenshots (in demo mode only).

#![allow(clippy::unwrap_used, clippy::expect_used, reason = "tests fail loudly")]

use binsight::config::{ConfigSources, validate};

const PASSWORD: &str = "correct horse battery staple";
const KEY: &str = "1b2c3d4e-5f60-4a1b-8c2d-3e4f5a6b7c8d";

/// A configuration read from these environment variables only.
fn environment(pairs: &[(&str, &str)]) -> ConfigSources {
    ConfigSources {
        env: pairs
            .iter()
            .map(|(name, value)| ((*name).to_owned(), (*value).to_owned()))
            .collect(),
        file: None,
    }
}

#[test]
fn starts_in_demo_mode_without_a_helius_key() {
    let loaded = validate(&environment(&[
        ("HOME", "/home/owner"),
        ("BINSIGHT_PASSWORD", PASSWORD),
        ("BINSIGHT_DEMO", "true"),
    ]))
    .unwrap();

    assert!(matches!(
        loaded.config.data_source,
        binsight::config::DataSourceConfig::Demo { frozen_at: None }
    ));
    assert_eq!(loaded.warnings, Vec::new());
}

#[test]
fn warns_that_the_helius_key_is_ignored_in_demo_mode() {
    let loaded = validate(&environment(&[
        ("HOME", "/home/owner"),
        ("BINSIGHT_PASSWORD", PASSWORD),
        ("BINSIGHT_HELIUS_API_KEY", KEY),
        ("BINSIGHT_DEMO", "true"),
    ]))
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
    let error = validate(&environment(&[
        ("HOME", "/home/owner"),
        ("BINSIGHT_PASSWORD", PASSWORD),
        ("BINSIGHT_DEMO", "yes"),
    ]))
    .unwrap_err();

    insta::assert_snapshot!(error.to_string(), @r"
    the configuration is invalid:
      - BINSIGHT_DEMO: expected true or false (set in the environment)
    ");
}

#[test]
fn keeps_the_demo_in_the_demo_subfolder_of_the_data_folder() {
    let demo = validate(&environment(&[
        ("HOME", "/home/owner"),
        ("BINSIGHT_PASSWORD", PASSWORD),
        ("BINSIGHT_DEMO", "true"),
    ]))
    .unwrap();
    let chain = validate(&environment(&[
        ("HOME", "/home/owner"),
        ("BINSIGHT_PASSWORD", PASSWORD),
        ("BINSIGHT_HELIUS_API_KEY", KEY),
    ]))
    .unwrap();

    let pinned = validate(&environment(&[
        ("BINSIGHT_PASSWORD", PASSWORD),
        ("BINSIGHT_DATA_DIR", "/data"),
        ("BINSIGHT_DEMO", "true"),
    ]))
    .unwrap();

    assert_eq!(
        demo.config.data_dir,
        std::path::Path::new("/home/owner/.local/share/binsight/demo")
    );
    assert_eq!(
        chain.config.data_dir,
        std::path::Path::new("/home/owner/.local/share/binsight")
    );
    assert_eq!(pinned.config.data_dir, std::path::Path::new("/data/demo"));
}

#[test]
fn freezes_the_demo_clock_at_the_given_instant() {
    let loaded = validate(&environment(&[
        ("HOME", "/home/owner"),
        ("BINSIGHT_PASSWORD", PASSWORD),
        ("BINSIGHT_DEMO", "true"),
        ("BINSIGHT_DEMO_NOW", "2026-10-06T14:30:00Z"),
    ]))
    .unwrap();

    let binsight::config::DataSourceConfig::Demo { frozen_at } = loaded.config.data_source else {
        panic!("expected demo mode");
    };
    assert_eq!(frozen_at, Some("2026-10-06T14:30:00Z".parse().unwrap()));
}

#[test]
fn refuses_a_frozen_clock_outside_demo_mode() {
    let error = validate(&environment(&[
        ("HOME", "/home/owner"),
        ("BINSIGHT_PASSWORD", PASSWORD),
        ("BINSIGHT_HELIUS_API_KEY", KEY),
        ("BINSIGHT_DEMO_NOW", "2026-10-06T14:30:00Z"),
    ]))
    .unwrap_err();

    insta::assert_snapshot!(error.to_string(), @r"
    the configuration is invalid:
      - BINSIGHT_DEMO_NOW: only a demo can freeze its clock; set BINSIGHT_DEMO=true or remove it
    ");
}

#[test]
fn refuses_a_demo_instant_that_is_not_rfc_3339() {
    let error = validate(&environment(&[
        ("HOME", "/home/owner"),
        ("BINSIGHT_PASSWORD", PASSWORD),
        ("BINSIGHT_DEMO", "true"),
        ("BINSIGHT_DEMO_NOW", "yesterday"),
    ]))
    .unwrap_err();

    assert_eq!(error.problems.len(), 1);
    assert_eq!(
        error.problems[0].setting,
        binsight::config::Setting::DemoNow
    );
}
