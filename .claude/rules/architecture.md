---
paths:
  - "crates/**"
  - "xtask/**"
  - "Cargo.toml"
---

# Architecture

## Principle

A **pure core** surrounded by thin **adapters**. Business logic (decoding, accounting, PnL, valuation rules) never
touches the network, the disk or the clock. Adapters translate between the outside world and the core and contain no
business logic.

## Crate layering (enforced by `cargo xtask layering`)

Dependencies only point downwards. A crate may depend on the crates listed for it, nothing else:

| Crate | Kind | May depend on |
|---|---|---|
| `binsight-core` | pure | — |
| `binsight-solana` | pure | core |
| `binsight-dlmm` | pure | core, solana |
| `binsight-ledger` | pure | core, solana, dlmm |
| `binsight-store` | disk I/O | core, solana, dlmm, ledger |
| `binsight-chain` | network I/O | core, solana |
| `binsight-engine` | orchestration | core, solana, dlmm, ledger, store, chain |
| `binsight-api` | HTTP | core, solana, dlmm, ledger, engine |
| `binsight` (binary) | composition root | all |
| `xtask` | tooling | none; nothing depends on it |

- `chain` knows nothing about DLMM: it is a transport.
- `api` never reaches `store` or `chain` directly: everything goes through `engine`.
- Pure crates may only use the external crates allowlisted in `xtask` (no async runtime, no logging, no I/O).
- External infrastructure crates have exactly one owner (e.g. SQLite only in `store`, HTTP server only in `api`).
- Declare a dependency only when it is used (`cargo machete` fails otherwise).

## Data model: three layers

1. **Raw transactions** (`raw_tx`): stored once per signature, immutable (a trigger forbids updates). The chain is
   only fetched once; everything else is recomputed locally from this registry.
2. **Decode results** (`tx_decode`): what the decoder concluded about each raw transaction (decoded, not applicable,
   or failed with its error) and how it executed, tagged with the `decoder_version` that produced them. Bumping the
   decoder version re-decodes from the registry, at zero RPC cost. The events are not stored: readers decode the raw
   transaction again.
3. **Projections** (`proj_*`: positions, PnL, curves): disposable, tagged with a `calc_version`, rebuilt when it
   changes. Projection tables are created and dropped by code, never by migrations.

No business logic in SQL: queries load and store; Rust computes.

## Migrations

Embedded in the binary, applied at startup after an automatic backup, checksummed. A released migration is never
edited; add a new one. A database newer than the binary is refused.

## Configuration

Read in one place (`binsight::config`), validated into typed settings, then passed down as plain structs. No crate
reads environment variables except the binary.
