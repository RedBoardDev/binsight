//! What the decoder makes of every mainnet fixture and synthetic scenario, and the guard that
//! ties it to its version.
//!
//! The output is what the store records (each event's kind and JSON payload) and the activity.
//! For each fixture it is a reviewable snapshot. For every fixture and every synthetic scenario
//! of the rule tests, its SHA-256 is recorded in `decoder-version.lock` with `DECODER_VERSION`:
//! an output that changes while the version stays the same fails here, because the engine
//! re-decodes stored transactions only when the version goes up. After bumping the version (or
//! adding a fixture or a scenario), record the new outputs with `just rust-decoder-lock`; a
//! version lower than the recorded one is always refused.

#![expect(
    clippy::unwrap_used,
    reason = "the helpers of this test fail it loudly when the lock cannot be read or written"
)]

mod common;

use std::collections::BTreeMap;
use std::fmt::Write as _;
use std::path::PathBuf;

use binsight_dlmm::{
    DECODER_NAME, DECODER_VERSION, LocatedEvent, decode_events, position_activity,
};
use binsight_solana::transaction::TransactionView;
use serde::Deserialize;
use sha2::{Digest, Sha256};

/// The variable that asks this test to record the outputs instead of checking them.
const UPDATE_VARIABLE: &str = "BINSIGHT_UPDATE_DECODER_LOCK";

/// The recorded outputs, as `decoder-version.lock` holds them.
#[derive(Debug, Deserialize)]
struct Lock {
    version: u32,
    outputs: BTreeMap<String, String>,
}

fn lock_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("decoder-version.lock")
}

/// The decoder's whole output on `tx`, in a readable form.
fn rendering(tx: &TransactionView) -> String {
    match decode_events(tx) {
        Ok(events) => output(tx, &events),
        Err(error) => format!("{error:?}\n"),
    }
}

/// The events as the store records them (place, kind, JSON payload), then the activity.
fn output(tx: &TransactionView, events: &[LocatedEvent]) -> String {
    let mut text = String::new();
    for located in events {
        let payload = serde_json::to_string(&located.event).unwrap();
        let kind = located.event.kind();
        writeln!(text, "{:?} {DECODER_NAME}.{kind} {payload}", located.at).unwrap();
    }
    let activity = position_activity(tx, events);
    writeln!(text, "{activity:#?}").unwrap();
    text
}

fn sha256_hex(text: &str) -> String {
    Sha256::digest(text)
        .iter()
        .fold(String::new(), |mut hex, byte| {
            write!(hex, "{byte:02x}").unwrap();
            hex
        })
}

/// The hash of the output on every fixture (by label) and every scenario (`scenario-<name>`).
fn current_outputs() -> BTreeMap<String, String> {
    let fixtures = common::every_fixture()
        .into_iter()
        .map(|(label, tx)| (label, sha256_hex(&rendering(&tx))));
    let scenarios = common::scenarios::every_scenario()
        .into_iter()
        .map(|(name, scenario)| {
            let text = output(&scenario.tx, &scenario.events);
            (format!("scenario-{name}"), sha256_hex(&text))
        });
    fixtures.chain(scenarios).collect()
}

fn read_lock() -> Lock {
    toml::from_str(&std::fs::read_to_string(lock_path()).unwrap()).unwrap()
}

fn write_lock(outputs: &BTreeMap<String, String>) {
    let mut text = String::from(
        "# Written by the corpus test of binsight-dlmm (BINSIGHT_UPDATE_DECODER_LOCK=1); do not \
         edit.\n# The SHA-256 of the decoder's output on each fixture, under the version that \
         produced it.\n",
    );
    writeln!(text, "version = {DECODER_VERSION}\n\n[outputs]").unwrap();
    for (label, hash) in outputs {
        writeln!(text, "\"{label}\" = \"{hash}\"").unwrap();
    }
    std::fs::write(lock_path(), text).unwrap();
}

/// The fixtures whose recorded output differs from `outputs`.
fn changed(lock: &Lock, outputs: &BTreeMap<String, String>) -> Vec<String> {
    lock.outputs
        .iter()
        .filter(|&(label, hash)| outputs.get(label).is_some_and(|now| now != hash))
        .map(|(label, _)| label.clone())
        .collect()
}

#[expect(
    clippy::disallowed_methods,
    reason = "the switch that turns this check into the recorder"
)]
fn is_update_requested() -> bool {
    std::env::var_os(UPDATE_VARIABLE).is_some_and(|value| value == "1")
}

#[test]
fn every_fixture_decodes_as_its_snapshot() {
    for (label, tx) in common::every_fixture() {
        insta::assert_snapshot!(label, rendering(&tx));
    }
}

#[test]
fn the_decoder_version_goes_up_whenever_its_output_changes() {
    let lock = read_lock();
    let outputs = current_outputs();
    let changed = changed(&lock, &outputs);
    if is_update_requested() {
        assert!(
            DECODER_VERSION >= lock.version,
            "DECODER_VERSION {DECODER_VERSION} is lower than the recorded {}",
            lock.version
        );
        assert!(
            DECODER_VERSION > lock.version || changed.is_empty(),
            "the output changed on {changed:?}: bump DECODER_VERSION before recording it"
        );
        write_lock(&outputs);
        return;
    }
    assert_eq!(
        lock.version, DECODER_VERSION,
        "decoder-version.lock records another version: run with {UPDATE_VARIABLE}=1"
    );
    assert_eq!(
        changed,
        Vec::<String>::new(),
        "the decoder output changed under the same version: bump DECODER_VERSION, then run with \
         {UPDATE_VARIABLE}=1"
    );
    let recorded: Vec<_> = lock.outputs.keys().collect();
    let fixtures: Vec<_> = outputs.keys().collect();
    assert_eq!(
        recorded, fixtures,
        "the fixtures or the scenarios changed: record them with {UPDATE_VARIABLE}=1"
    );
}
