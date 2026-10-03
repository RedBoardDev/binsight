# Testing

A behaviour without a test does not exist. A bug fix without a test that reproduces the bug is not a fix.

## Names

Tests are sentences describing the behaviour, in the present tense:
`rejects_login_when_password_is_wrong`, `keeps_the_first_row_when_a_raw_tx_is_inserted_twice`,
`it('shows the field error when the password is wrong')`.

## Rust

- Unit tests in a `#[cfg(test)] mod tests` at the bottom of the file; integration tests in `crates/<c>/tests/<topic>.rs`
  with shared helpers in `tests/common/`.
- Run with `cargo nextest` (+ `cargo test --doc`).
- **Property tests** (`proptest`) for invariants: round-trips (decimal strings, base58), arithmetic laws, and the ledger
  invariant "the sum of a transaction's entries equals the wallet's real balance change, to the lamport".
- **Snapshot tests** (`insta`) for human-readable outputs: JSON error bodies, `--help`, config error reports. Snapshots
  are committed and reviewed like code.
- **Real transactions as fixtures**: decoding and accounting are tested against real mainnet transactions stored under
  `tests/fixtures/` (public on-chain data only). Every accounting rule and every past bug has a named test with its
  expected numbers.
- SQLite tests use a real temporary database, never a mock. HTTP tests call the router in-process. Time is always
  injected (`FixedClock`); no test sleeps on the wall clock.

## Web

- Domain first: a `*.spec.ts` next to each rules file (Vitest, `node` environment).
- Components: Testing Library + user-event under jsdom through `renderWithProviders`.
- End-to-end: a few Playwright scenarios against the real binary, with an axe accessibility check (no serious or
  critical violation).

## Determinism

Tests never hit the network or a real RPC provider. A flaky test is a bug: fix it or delete it, never retry it.
