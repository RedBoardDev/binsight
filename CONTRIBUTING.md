# Contributing to Binsight

## Prerequisites

- **Node 22** (see `.nvmrc`) and **Yarn 4** — `corepack enable` then `yarn install`.
- **Docker** for the local Postgres (`make db-up`).
- For the macOS app: **Xcode 26** (the `BinsightKit` package uses swift-tools 6.2 and targets the
  macOS 26 SDK) and **XcodeGen** (`brew install xcodegen`). A free Apple ID is enough (signs locally).

## Layout

```
api/         Fastify + TypeScript engine (DDD/hexagonal: domain / application / infrastructure), Postgres via drizzle
shared/      zod contract shared by the API and the web (the Swift client mirrors it)
web/         Next.js 16 web app — desktop + mobile layouts, installable PWA with Web Push
apps/        SwiftUI macOS menu-bar app (BinsightMac) + the BinsightKit Swift package, generated with XcodeGen
deploy/      production runbook + nginx vhosts (docker-compose.prod.yml, deploy.sh at the root)
Makefile     one entrypoint: setup, db-up, dev-api, dev-web, install-mac, verify…
```

## Workflow

1. `make setup` (creates `.env`), then fill `AUTH_SECRET` (required, ≥32 chars — `openssl rand -hex 32`) + `SOLANA_WS_URL` (a Helius `wss://` URL).
2. `make db-up` (Postgres on `localhost:5435`), `make dev-api` (API on `:8787`), `make dev-web`
   (web on `:3000`); `make install-mac` for the menu-bar app.
3. Before opening a PR: **`make verify`** (typecheck + Biome + tests — the API and the web both run
   vitest; one workspace alone: `yarn workspace @binsight/api test` / `yarn workspace @binsight/web test`)
   and `make apps-test` for the Swift package. Keep it green.
4. **Conventional commits** (`feat:`, `fix:`, `refactor:`, `chore:`, `docs:`, `test:`).
5. Comments explain *why*; no secrets in the repo. Keep files focused — as a guideline, split a
   source file that grows past ~400 lines (tests are exempt).

Test a notification end to end with a registered account:
`make notify-test BINSIGHT_ADDRESS=<wallet> BINSIGHT_PASSWORD=<password>` (`KIND=oor_enter` to change
the event).

## Conventions

- TypeScript: strict, no `any` without justification, Biome-clean.
- Swift: shared logic lives in `BinsightKit`; the `BinsightMac` app target stays a thin shell. The
  kit is **macOS-only** (mobile is covered by the web PWA), so AppKit is fine
  there; there is no portability constraint and no `#if os(...)` split. See `apps/README.md`.
- The `shared` zod schema is the source of truth for the wire contract — update it (and the
  Swift `Models.swift` mirror) together.

## Database migrations (drizzle)

Migrations live in `api/drizzle/` and are applied at API boot (and by the CI `Migrations` job with
`yarn workspace @binsight/api db:migrate`). **From `0013` on they are hand-written SQL**:

1. Write the next file by hand, e.g. `api/drizzle/0015_<name>.sql`, with `--> statement-breakpoint`
   between statements. Prefer idempotent DDL (`ADD COLUMN IF NOT EXISTS`, …) and put any backfill
   (`UPDATE … FROM`) in the same file.
2. Append its entry to `api/drizzle/meta/_journal.json` by hand (next `idx`, `"version": "7"`, a
   `when` larger than every previous one, `tag` = the file name without `.sql`,
   `"breakpoints": true`). The migrator only runs entries whose `when` is newer than the last one
   recorded in `__drizzle_migrations`, so a smaller `when` is silently skipped.
3. Update `api/src/infrastructure/persistence/schema.ts` to match.

**Do not run `drizzle-kit generate` or `drizzle-kit push`** (`db:generate` / `db:push`): the snapshots
stop at `meta/0012_snapshot.json`, so `generate` would diff against 0012 and re-emit everything added
since, and `push` bypasses the migration history altogether. Never edit a migration that has already
been applied in production: it will not run again, so the change never reaches that database — add a
new migration instead.
