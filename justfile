set shell := ["bash", "-euo", "pipefail", "-c"]

# List the recipes.
default:
    @just --list --unsorted

# --- Everyday -------------------------------------------------------------

# Install the git hooks (the web dependencies join this recipe with the web app).
[group('setup')]
setup: hooks

# Link the commit-msg hook (keeps any hook you already have).
[group('setup')]
hooks:
    #!/usr/bin/env bash
    set -euo pipefail
    hook="$(git rev-parse --git-path hooks)/commit-msg"
    if [ -e "$hook" ] && [ ! -L "$hook" ]; then echo "keeping your own $hook"; exit 0; fi
    mkdir -p "$(dirname "$hook")"
    ln -sf "$PWD/.githooks/commit-msg" "$hook"

# Run the server with the development config in .dev/.
[group('dev')]
dev: rust-dev-env
    just rust-run

# Everything CI checks.
check: rust-check

# Run every test.
test: rust-test

# Format all the code.
fmt: rust-fmt

# Build the release binary.
build: rust-build

# --- Rust -----------------------------------------------------------------

# Format the Rust code.
[group('rust')]
rust-fmt:
    cargo fmt --all

# Check the Rust formatting without changing any file.
[group('rust')]
rust-fmt-check:
    cargo fmt --all --check

# Lint with clippy; any warning fails.
[group('rust')]
rust-lint:
    cargo clippy --workspace --all-targets --locked -- -D warnings

# Run the tests with nextest (JUnit report in CI), then the documentation examples.
[group('rust')]
rust-test:
    cargo nextest run --workspace --locked --profile {{ if env("CI", "") == "true" { "ci" } else { "default" } }}
    cargo test --workspace --doc --locked

# Check licenses, security advisories, banned crates and sources.
[group('rust')]
rust-deny:
    cargo deny --locked check

# Check that every crate only depends on what its layer allows.
[group('rust')]
rust-layering:
    cargo xtask layering

# Check the size limits of source files and folders.
[group('rust')]
rust-structure:
    cargo xtask structure

# Find declared dependencies that are never used.
[group('rust')]
rust-unused-deps:
    cargo machete

# Everything CI checks on the Rust side.
[group('rust')]
rust-check: rust-fmt-check rust-lint rust-test rust-deny rust-layering rust-structure rust-unused-deps

# Write a development config in .dev/ (ignored by git).
[group('rust')]
rust-dev-env:
    mkdir -p .dev/data && chmod 700 .dev
    test -f .dev/binsight.env || printf 'BINSIGHT_PASSWORD=dev-password-change-me\nBINSIGHT_HELIUS_API_KEY=dev-placeholder-key\nBINSIGHT_DATA_DIR=%s/.dev/data\n' "$PWD" > .dev/binsight.env
    chmod 600 .dev/binsight.env

# Run the server with the development config.
[group('rust')]
rust-run *ARGS:
    BINSIGHT_CONFIG_FILE=.dev/binsight.env cargo run -p binsight -- run {{ ARGS }}

# Build the release binary from scratch, so it embeds the current web build.
[group('rust')]
rust-build:
    cargo clean -p binsight --release
    cargo build --release --locked -p binsight
