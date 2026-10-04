# Contributing to binsight

Thank you for your interest. Bug reports, fixes and improvements are welcome. For a new feature, open an issue
first so we can agree on the approach before you spend time on it.

Architecture and code cleanliness come first in this project. The conventions in [`CLAUDE.md`](CLAUDE.md) and
[`.claude/rules/`](.claude/rules/) apply to every contributor, human or AI; CI enforces most of them and review
the rest.

## Prerequisites

- [rustup](https://rustup.rs): the toolchain pinned in `rust-toolchain.toml` installs itself on the first
  `cargo` command.
- The Rust tools the checks use:
  `cargo install --locked cargo-nextest cargo-deny cargo-machete committed` and
  `cargo install --locked cargo-about --features cli`.
- Node.js 24: `nvm install` reads [`.nvmrc`](.nvmrc).
- pnpm at the exact version of `packageManager` in [`web/package.json`](web/package.json):
  `npm install --global pnpm@12.8.1` (not Corepack).
- [just](https://just.systems), which runs the same recipes as CI.

## Getting started

```sh
just setup   # link the commit-msg hook and install the web dependencies
just dev     # the server on :8080 and the Vite dev server on http://localhost:5173
```

`just dev` writes a development configuration in `.dev/binsight.env` (ignored by git) on its first run; sign
in with the password it contains. The Vite dev server proxies `/api` to the server, so the browser sees one
origin, as in production.

## Recipes

`just --list` shows them all. The ones you will use most:

| Recipe | What it does |
|---|---|
| `just check` | Everything CI checks: formatting, lints, tests, licenses, layering, size limits, OpenAPI and web client freshness, translations, web build |
| `just fmt` | Format the Rust and web code |
| `just test` | Rust and web unit tests |
| `just dev` | Run the server and the Vite dev server together |
| `just build` | Build the web app, then the release binary that embeds it |
| `just e2e` | Playwright smoke test against the real binary (`pnpm exec playwright install chromium` once) |
| `just openapi` | Regenerate `openapi/v1.json` from the Rust code, then the typed web client |
| `just web-*`, `just rust-*` | The same steps for one side only |
| `just docker-build`, `docker-up`, `docker-down` | Build and run the image locally, under the Compose project `binsight-local` |

**`just check` must pass before every commit.**

## Repository layout

| Path | What lives there |
|---|---|
| `crates/` | The Rust workspace: pure crates (`core`, `solana`, `dlmm`, `ledger`), adapters (`store`, `chain`), orchestration (`engine`), HTTP (`api`) and the `binsight` binary. Dependencies only point downwards; `cargo xtask layering` checks it ([architecture rules](.claude/rules/architecture.md)). |
| `xtask/` | Repository checks: crate layering and file/folder size limits. |
| `web/` | The web app (React, TypeScript, Vite, HeroUI, Tailwind, Lingui). [`web/README.md`](web/README.md) explains how to work on it; its conventions are in [`.claude/rules/web.md`](.claude/rules/web.md). |
| `openapi/v1.json` | The API contract, generated from the Rust code. |

`openapi/v1.json` and `web/src/lib/api/generated/openapi.d.ts` are generated: never edit them by hand. After
an API change, run `just openapi` and commit both files with the change. On a merge conflict in either one,
take one side and run `just openapi` again.

`crates/binsight/third-party-licenses.txt` is generated too: after a change to `Cargo.lock`, run
`just rust-licenses` and commit it (CI fails when it is stale). The web build appends it to the notices of the
web packages, and the binary serves both at `/third-party-licenses.txt`.

## Size and structure

A source file has at most 500 lines (aim for 250) and a folder at most 12 source files; `cargo xtask structure`
fails otherwise. Split by concept, never into `utils/` or `helpers/`. See
[clean-code](.claude/rules/clean-code.md).

## Commits

- [Conventional Commits](https://www.conventionalcommits.org): `type(scope): summary`, checked by `committed`
  in CI and by the hook `just hooks` installs. Types: `feat`, `fix`, `refactor`, `perf`, `test`, `docs`,
  `build`, `ci`, `chore`. Scopes: a crate name (`core`, `api`, `binsight`…), `web`, `xtask`, `deps`, `github`.
- The summary is imperative and lowercase, without a trailing period, under 72 characters.
- The body, wrapped at 72 columns, explains **why**: the problem, the decision, the alternative rejected.
- One commit, one intent: it builds, passes `just check` and could be reverted alone. No merge commits; rebase
  on `main`.

Details in [git](.claude/rules/git.md).

## Translations

The interface is in English, French and German, and the English text is the message key. Every new or changed
string ships with its French and German translations in the same commit: run `just web-i18n`, then fill in the
new `msgstr` entries in `web/src/locales/fr/messages.po` and `web/src/locales/de/messages.po`. A missing
translation fails the build.

## Tests

A behaviour without a test does not exist, and a bug fix comes with the test that reproduces the bug.

- Rust: unit tests next to the code, integration tests in `crates/<crate>/tests/`, run with `cargo nextest`;
  `proptest` for invariants, `insta` snapshots for human-readable output, real temporary SQLite databases.
- Web: Vitest specs next to each file (domain code without a DOM, components with Testing Library), and the
  Playwright smoke test with axe against the real binary.
- Tests never touch the network or a real RPC provider.

See [testing](.claude/rules/testing.md).

## Pull requests

- `just check` is green, and the PR does one thing.
- Fill in the template; attach desktop and mobile screenshots for an interface change.
- Dependencies must have a permissive license (MIT, Apache-2.0, BSD, ISC…, never GPL, AGPL or LGPL);
  `cargo deny` and the web build check it. Explain in the commit body why a new dependency is needed.

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).

## Security

Never paste a Helius API key or a password into an issue, a log or a screenshot. Report vulnerabilities
privately, as described in [SECURITY.md](SECURITY.md).
