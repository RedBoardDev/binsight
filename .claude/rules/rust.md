---
paths:
  - "**/*.rs"
  - "**/Cargo.toml"
---

# Rust

Assume the reader does not know Rust well. Write the most obvious code that works.

## Style

- Edition 2024, the pinned toolchain, `rustfmt` defaults from `rustfmt.toml`. `cargo clippy -D warnings` with the
  workspace lints (pedantic, `unsafe_code = "forbid"`).
- No `unwrap`, `expect`, `panic!`, `todo!`, `unreachable!`, indexing `[]` or slicing outside tests. Handle the case.
- No `macro_rules!` in our code. Derive and attribute macros from dependencies are fine.
- No `as` casts between numbers: use `TryFrom`/`From`. Pure crates forbid floats entirely (see money-and-exactness).
- Prefer owned, explicit types at public boundaries; avoid lifetime-heavy APIs unless they remove a real cost.
- No trait or generic unless there are two real implementations (or a test double that needs it). Concrete first.
- `#[allow]` is forbidden without `reason = "…"`; prefer `#[expect(…, reason = "…")]`.

## Errors

- Libraries: one `thiserror` enum per public boundary (`StoreError`, `EngineError`) or per distinct domain
  (`AmountError`). Messages lowercase, no trailing period, saying what failed on what:
  `"could not open the database at {path}"`. Chain causes with `#[source]`.
- Never `Box<dyn Error>` or `String` as a public error type. `anyhow` only in the binary and `xtask`.
- The binary maps failures to stable exit codes (`78` config, `75` locked data dir, `65` incompatible database,
  `74` I/O, `1` unexpected).

## Logging

- `tracing` with structured fields, English, lowercase: `info!(path = %backup.display(), "database backed up")`.
- Levels: `error` = a human must act; `warn` = degraded but self-healing; `info` = lifecycle; `debug` = per
  request/transaction; `trace` = payloads.
- Secrets are `SecretString` and never logged; never log a URL containing an API key.

## Async

- `tokio` only outside pure crates. No blocking call on an async task (SQLite goes through the store's pool).
- Every network call has a timeout. Every long-running task listens to the shutdown token.

## Documentation

- Every crate and module starts with `//!`: what it does, what it does not do, what it may depend on.
- Every public item has `///`. Fallible public functions document `# Errors`.
