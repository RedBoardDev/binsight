# binsight web app

The browser app of binsight: a React + TypeScript single-page app built with Vite and served by the Rust
binary from the same origin.

**The conventions are in [`.claude/rules/web.md`](../.claude/rules/web.md)** (module layout, imports, naming,
data, UI, i18n). They are binding, as are [clean-code](../.claude/rules/clean-code.md),
[testing](../.claude/rules/testing.md) and [money-and-exactness](../.claude/rules/money-and-exactness.md). This
file only explains how to work on the app.

## Prerequisites

- Node.js from [`.nvmrc`](../.nvmrc) (`nvm install` reads it).
- pnpm at the exact version of `packageManager` in [`package.json`](package.json):
  `npm install --global pnpm@<version>`. Do not use Corepack.
- [just](https://just.systems), to run the same recipes as CI from the repository root.

## Everyday commands

Run them from the repository root:

| Command | What it does |
|---|---|
| `just web-install` | Install the dependencies exactly as locked |
| `just web-dev` | Vite dev server on http://localhost:5173 |
| `just dev` | The Rust server and the Vite dev server together |
| `just web-fix` | Format the code and apply the safe lint fixes |
| `just web-check` | Everything CI checks on the web side |
| `just check` | Everything CI checks, Rust and web |

Inside `web/`, the same steps are `pnpm` scripts: `pnpm dev`, `pnpm lint`, `pnpm typecheck`, `pnpm test`,
`pnpm build`.

The dev server proxies `/api` to the server on `http://127.0.0.1:8080`; set `BINSIGHT_DEV_API_URL` to use
another address. The browser sees a single origin, so the session cookie and the CSRF check behave as in
production.

## Checks

`just web-check` runs, in this order:

1. `pnpm lint`: Biome, formatting and lints, without changing any file.
2. `pnpm typecheck`: TypeScript in strict mode.
3. `pnpm test`: Vitest. Pure code (`Domain/`, `lib/`, the service worker, `core/` modules without React) runs
   under Node; components and hooks run under jsdom. `test/architecture.spec.ts` checks the module rules of
   `web.md` over `src/`: its failure message names the rule and the fix.
4. `pnpm build`: the production build in `dist/`.

## Adding a dependency

Ask first: most needs are already covered (see the reuse order in `web.md`). Then:

- install an exact version (`pnpm add <name>@<version>`; `saveExact` is on);
- check that its license is permissive (MIT, ISC, Apache-2.0, BSD…), never GPL, AGPL or LGPL;
- if pnpm reports an ignored build script, review the package and record the decision in `allowBuilds` in
  [`pnpm-workspace.yaml`](pnpm-workspace.yaml);
- explain in the commit body what the package does that we should not write ourselves.
