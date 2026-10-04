set shell := ["bash", "-euo", "pipefail", "-c"]

web := "pnpm --dir web"

# List the recipes.
default:
    @just --list --unsorted

# --- Everyday -------------------------------------------------------------

# Install the git hooks and the web dependencies.
[group('setup')]
setup: hooks web-install

# Link the commit-msg hook (keeps any hook you already have).
[group('setup')]
hooks:
    #!/usr/bin/env bash
    set -euo pipefail
    hook="$(git rev-parse --git-path hooks)/commit-msg"
    if [ -e "$hook" ] && [ ! -L "$hook" ]; then echo "keeping your own $hook"; exit 0; fi
    mkdir -p "$(dirname "$hook")"
    ln -sf "$PWD/.githooks/commit-msg" "$hook"

# Run the server and the Vite dev server together (http://localhost:5173); Ctrl-C stops both.
[group('dev')]
dev: rust-dev-env
    #!/usr/bin/env bash
    set -euo pipefail
    trap 'kill 0' EXIT
    just rust-run &
    just web-dev &
    wait -n

# Everything CI checks.
check: rust-check web-check

# Run every test.
test: rust-test web-test

# Format all the code.
fmt: rust-fmt web-fix

# Build the web app, then the release binary that embeds it.
build: web-build rust-build

# Regenerate the OpenAPI contract, then the typed web client from it (commit both).
openapi: rust-openapi web-openapi

# Check that the contract matches the Rust code and the web client matches the contract.
openapi-check: rust-openapi-check web-openapi-check

# A debug build reads web/dist from disk, so a new web build needs no Rust rebuild. Each test
# starts its own server from target/debug/binsight on a temporary data folder.
[doc('End-to-end smoke test (Playwright + axe) against the real server.')]
e2e: web-build
    cargo build --locked -p binsight
    {{ web }} e2e

# --- Web ------------------------------------------------------------------

# Install the web dependencies exactly as locked.
[group('web')]
web-install:
    {{ web }} install --frozen-lockfile

# Run the Vite dev server (http://localhost:5173, /api proxied to the server).
[group('web')]
web-dev:
    {{ web }} dev

# Check the web formatting and lints without changing any file.
[group('web')]
web-lint:
    {{ web }} lint

# Format the web code and apply the safe lint fixes.
[group('web')]
web-fix:
    {{ web }} fix

# Typecheck the web app.
[group('web')]
web-typecheck:
    {{ web }} typecheck

# Run the web unit tests and the architecture test.
[group('web')]
web-test:
    {{ web }} test

# Extract the interface messages into the en/fr/de catalogs (then translate the new ones).
[group('web')]
web-i18n:
    {{ web }} i18n:extract

# Check that the catalogs are up to date and every message is translated.
[group('web')]
web-i18n-check:
    {{ web }} i18n:check

# Regenerate the typed API client from openapi/v1.json.
[group('web')]
web-openapi:
    {{ web }} openapi:generate

# The script's git pathspec is relative to web/: one that matches nothing would pass in silence.
[doc('Check that the committed API client matches openapi/v1.json.')]
[group('web')]
web-openapi-check:
    {{ web }} openapi:check

# Build the web app into web/dist.
[group('web')]
web-build:
    {{ web }} build

# Everything CI checks on the web side.
[group('web')]
web-check: web-lint web-typecheck web-test web-i18n-check web-openapi-check web-build

# --- Rust -----------------------------------------------------------------

# Format the Rust code.
[group('rust')]
rust-fmt:
    cargo fmt --all

# Check the Rust formatting without changing any file.
[group('rust')]
rust-fmt-check:
    cargo fmt --all --check

# Without --all-targets, a dependency declared only for the tests cannot hide a crate that does
# not build on its own.
[doc('Compile every crate as it ships, without its tests.')]
[group('rust')]
rust-build-check:
    cargo check --workspace --locked

# Lint with clippy; any warning fails.
[group('rust')]
rust-lint:
    cargo clippy --workspace --all-targets --locked -- -D warnings

# Run the tests with nextest (JUnit report in CI), then the documentation examples.
[group('rust')]
rust-test:
    cargo nextest run --workspace --locked --profile {{ if env("CI", "") == "true" { "ci" } else { "default" } }}
    cargo test --workspace --doc --locked

# Regenerate openapi/v1.json from the Rust code.
[group('rust')]
rust-openapi:
    BINSIGHT_UPDATE_OPENAPI=1 cargo nextest run --locked -p binsight-api -E 'binary(openapi_contract)'

# Check that openapi/v1.json matches the Rust code (also part of rust-test).
[group('rust')]
rust-openapi-check:
    cargo nextest run --locked -p binsight-api -E 'binary(openapi_contract)'

# Check licenses, security advisories, banned crates and sources.
[group('rust')]
rust-deny:
    cargo deny --locked check

# The notices of the crates the binary ships, which the web build appends to its own (commit it).
# Some license texts use CRLF line endings; the committed file uses LF, like every text file here.
[group('rust')]
rust-licenses:
    cargo about generate --frozen -c .config/about.toml -m crates/binsight/Cargo.toml .config/about.hbs | tr -d '\r' > crates/binsight/third-party-licenses.txt

# Offline, so the crates must be downloaded first; a stale file means `just rust-licenses` was not run.
[doc('Check that the committed Rust license notices match Cargo.lock.')]
[group('rust')]
rust-licenses-check:
    cargo fetch --locked
    cargo about generate --frozen -c .config/about.toml -m crates/binsight/Cargo.toml .config/about.hbs | tr -d '\r' | diff -u crates/binsight/third-party-licenses.txt - || { echo "the Rust license notices are stale: run just rust-licenses"; exit 1; }

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
rust-check: rust-fmt-check rust-build-check rust-lint rust-test rust-deny rust-licenses-check rust-layering rust-structure rust-unused-deps

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

# --- Docker: always under the project name binsight-local, never another one -----

# Build the image as binsight:local.
[group('docker')]
docker-build:
    docker build -t binsight:local .

# Run binsight:local with Docker Compose on http://localhost:18080 (password from .dev/binsight.env).
[group('docker')]
docker-up: docker-build rust-dev-env
    BINSIGHT_IMAGE=binsight:local BINSIGHT_PORT=18080 docker compose -p binsight-local --env-file .dev/binsight.env up

# Stop and remove the binsight-local containers (the data volume stays).
[group('docker')]
docker-down:
    docker compose -p binsight-local --env-file .dev/binsight.env down
