# binsight

Self-hostable portfolio tracker for Meteora DLMM liquidity positions on Solana, with **exact, on-chain-verified PnL**.
One instance serves one owner who tracks a handful of wallets, on their own Helius API key (the free plan must be
enough for ~10 wallets).

**Architecture and code cleanliness are the top priority of this project.** Every change follows the rules in
[`.claude/rules/`](.claude/rules/). They are not suggestions: CI enforces most of them, review enforces the rest.

## Repository map

| Path | What lives there |
|---|---|
| `crates/core` | Domain units (amounts, ids, exactness, clock). Pure. |
| `crates/solana` | Solana primitives: addresses, signatures, transaction reading (v0 and v1). Pure. |
| `crates/dlmm` | Meteora DLMM: event/instruction decoding, accounts, fixed-point bin math. Pure. |
| `crates/ledger` | Accounting: entries, PnL, FIFO, Net Worth, curves. Pure. |
| `crates/store` | SQLite: raw transaction registry, versioned decode results, projections, migrations. Disk I/O. |
| `crates/chain` | Helius JSON-RPC/WebSocket client, credit metering and budget. Network I/O. |
| `crates/engine` | Orchestration: ingestion, catch-up, repair, valuation, notifications. |
| `crates/api` | HTTP: REST `/api/v1` + SSE, password session, generated OpenAPI contract. |
| `crates/demo` | The generated demo world (`BINSIGHT_DEMO=true`): deterministic facts served through the engine's queries. |
| `crates/binsight` | The binary: `init`, `run`, `admin`; composition root; embeds the web build. |
| `xtask/` | Repository checks (`layering`, `structure`). |
| `web/` | The web app / PWA (React, TypeScript, Vite, HeroUI, Tailwind, Lingui). |
| `openapi/v1.json` | The API contract, generated from Rust — never edited by hand. |

## Commands

```sh
just check        # everything CI runs: format, lints, tests, layering, structure, licenses, OpenAPI, web checks
just dev          # Rust server + Vite dev server with the API proxy
just test         # Rust and web tests
just fmt          # format everything
just openapi      # regenerate openapi/v1.json and the typed web client
```

`just check` must be green before every commit.

## Rules (read the ones that apply before writing code)

| File | Applies to |
|---|---|
| [clean-code](.claude/rules/clean-code.md) | everything: naming, functions, files, folders, size limits |
| [architecture](.claude/rules/architecture.md) | the crate layering and the data model |
| [rust](.claude/rules/rust.md) | Rust code |
| [money-and-exactness](.claude/rules/money-and-exactness.md) | anything that touches an amount, a price or a PnL figure |
| [api](.claude/rules/api.md) | the HTTP API, SSE and the OpenAPI contract |
| [web](.claude/rules/web.md) | the web app |
| [testing](.claude/rules/testing.md) | tests on both sides |
| [git](.claude/rules/git.md) | branches, commits, history |

## When unsure

Find the closest existing example in the codebase and follow it. If none fits, or a rule seems to be in the way, stop
and ask instead of improvising a new pattern.
