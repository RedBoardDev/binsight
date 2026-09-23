# Binsight

Real-time, self-hosted monitor for your **Meteora DLMM liquidity positions** on Solana —
a **web app** (desktop and mobile layouts, installable as a PWA with Web Push), a **macOS menu-bar
app**, and the API that feeds them. PnL is faithful to on-chain (`pnlSol`, validated). Free to run
(no paid Apple account needed).

## Why

You open LP positions on Meteora and want to know — at a glance and via notifications — your
live PnL, what's in/out of range, your fees, your wallet total, and your realized PnL today,
across multiple wallets. Binsight does that without a dashboard to babysit.

## What you get

- **Web app** — the full dashboard: live PnL, portfolio and wallet totals, open positions with range
  bars and charts, closed history, stats and settings. A desktop layout and a mobile layout;
  install it as a **PWA** (on a phone: *Add to Home Screen*) to get **Web Push** notifications.
- **macOS menu-bar app** — the always-on glance: live PnL, wallet total, fees, today's realized PnL,
  open positions with range bars, closed history; native notifications while you're at your Mac.
- **Notifications** — for each range/close event:
  - **Web Push** to every installed PWA subscribed for that wallet — always sent, whatever else is
    open (so you may briefly see both a push and an in-app alert);
  - a **native macOS notification** (or an in-app alert in an open tab) while a client is active;
  - **[Bark](https://bark.day.app)** push to your phone as the owner's fallback, only when no client
    is active.

  No Apple Developer Program required.
- **Resilient engine** — a decoupled on-chain DLMM engine (history backfill when a wallet registers,
  then Solana WS delta ingest) is the default source; designed to never miss a position (late is fine,
  missing is not). Runs on a **free** Solana RPC plan: one transaction read feeds positions, cash-flow and
  swap history alike, and a poll that finds nothing costs a single credit.

## Quick start

Needs Node 22, Docker (for Postgres) and a Helius account (the free plan works).

```sh
corepack enable                 # Yarn 4
make install                    # creates .env from the template, then installs dependencies
#   → edit .env: set AUTH_SECRET (≥32 chars, e.g. `openssl rand -hex 32`) and SOLANA_WS_URL (a Helius wss:// URL).
#     Account passwords are set during web registration, not in .env.
make db-up                      # Postgres in Docker, on localhost:5435 (the API's default DATABASE_URL)
make dev-api                    # the API on :8787 — applies migrations, then logs "Binsight API listening"
make dev-web                    # in another terminal: the web app on http://localhost:3000
```

`make dev-api` needs the database: without `make db-up` it exits with `Fatal startup error`. The web
app talks to the API at `localhost:8787` by default, so nothing else needs configuring locally.

Open http://localhost:3000 and register a wallet (connect a wallet → sign a one-time message →
choose a password). Then, on a Mac, install the menu-bar app — only the API URL is baked in from your
`.env`; you sign in with that wallet **address + password** in the app's Settings:

```sh
make install-mac                # macOS menu-bar app → /Applications, signed with your free cert
```

Add the wallets to monitor in **Settings** (web or Mac app). On macOS, allow notifications when
prompted. For push away from your screens, install the web app as a PWA and enable notifications in
it, and/or install the [Bark](https://bark.day.app) app and set its key (`BARK_KEY`) in the API config.

## Commands

`make help` lists everything. Key: `make db-up` / `dev-api` / `dev-web` (local dev), `make verify`
(typecheck + Biome + tests), `make apps-test` (Swift package tests), `make install-mac`,
`make notify-test BINSIGHT_ADDRESS=<wallet> BINSIGHT_PASSWORD=<password>` (fire a test
notification), `make up` / `down` / `logs` (Docker Compose dev stack: Postgres + API).

Production (single VPS behind nginx): see [`deploy/README.md`](./deploy/README.md).

## Notes

- A Solana WS/RPC endpoint (e.g. **Helius**, free tier works) is **required** to boot the API.
- Auth is per-account, keyed on a Solana wallet address: clients `POST {address, password}` to
  `/auth/login` and receive a JWT (Bearer for REST; the WebSocket takes it in the `Authorization`
  header, or — for browsers — a short-lived ticket from `/auth/ws-ticket` in `?token=`). The JWT
  signing key is `AUTH_SECRET`. No static API token.
- Registration proves wallet ownership with a signed one-time message (SIWS) and is limited to
  whitelisted addresses; `OWNER_ADDRESS` is whitelisted automatically. (`OPEN_ACCESS_MODE=true`
  switches to address + password only — no signature, no whitelist, single-wallet accounts,
  notifications off.)

## License

[MIT](./LICENSE) © RedBoardDev
