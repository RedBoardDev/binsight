# Production deployment

Single VPS, fronted by the host **nginx**. The app runs as three containers via
`docker-compose.prod.yml`; nginx terminates TLS for two hostnames and routes traffic.

```
                           ┌──────────────────── VPS ─────────────────────┐
 browser ──HTTPS──▶ binsight.thomasott.fr ─┬─ "/"     ─▶ web 127.0.0.1:3000  (Next.js UI + /api BFF)
                                           └─ "/live" ─▶ api 127.0.0.1:8787  (WebSocket only)
 macOS app ─HTTPS─▶ api.binsight.thomasott.fr ── "/" ─▶ api 127.0.0.1:8787  (whole API: REST + /live)
                                                 web ──internal──▶ api ──internal──▶ postgres
```

What is public:

- **`binsight.thomasott.fr`** — the web app, plus the API's `/live` WebSocket (the browser opens it
  directly with a short-lived ticket minted by the BFF).
- **`api.binsight.thomasott.fr`** — the **whole API** (REST + `/live`). The macOS menu-bar app talks to
  the API directly (wallet address + password → JWT), so it needs this host. Every route except the
  `/auth/*` sign-in endpoints, `/live` (which checks its own token), `/health` and `/config/app`
  requires a Bearer JWT.

Postgres is reachable only on the internal Docker network. The containers bind to `127.0.0.1` only;
nginx is the sole entry point.

## 1. Prerequisites (on the VPS)

- Docker Engine + the Compose plugin (`docker compose version`).
- The existing host nginx + `certbot` (with the nginx or webroot plugin).
- The repo cloned somewhere, e.g. `/opt/binsight`.

## 2. DNS (you handle this in Route53)

Two `A` records → the VPS public IP:

- `binsight.thomasott.fr`
- `api.binsight.thomasott.fr`

## 3. Secrets on the host (never commit them)

There are **two** files next to `docker-compose.prod.yml`, read in different ways:

| File | Read by | Holds |
|------|---------|-------|
| `.env` | **Compose itself**, for `${…}` substitution while parsing `docker-compose.prod.yml` | `POSTGRES_PASSWORD` (required), optionally `NEXT_PUBLIC_API_WS_URL` |
| `.env.prod` | The **api container** (`env_file`) | Everything the API reads at runtime (table below) |

### 3a. `.env` — the Postgres password

```bash
echo "POSTGRES_PASSWORD=$(openssl rand -hex 32)" >> .env    # hex: safe inside the DATABASE_URL
chmod 600 .env
```

`POSTGRES_PASSWORD` has **no fallback**: if it is missing, every `docker compose -f
docker-compose.prod.yml …` command (and so `./deploy.sh`) stops at parse time with
`set POSTGRES_PASSWORD in the host .env`, before any image is built or container replaced. Compose
injects it both into the postgres container and into the API's `DATABASE_URL`. Putting it in
`.env.prod` does **not** work — that file is only passed to the api container.

Postgres applies `POSTGRES_PASSWORD` only when it initialises an **empty** volume. On an existing
database, changing the variable alone does not change the password — it just breaks the API's
connection. To rotate it (or to move off the old default `meteora`):

```bash
# 1. Change the role's password inside the running database (interactive, stays out of shell history;
#    local connections inside the container need no password). Use a hex value, as above.
docker exec -it binsight-postgres-1 psql -U meteora -d meteora -c '\password meteora'
# 2. Right away, put the SAME value in .env as POSTGRES_PASSWORD=…
# 3. Recreate postgres + api with the new value (the data volume is untouched):
docker compose -f docker-compose.prod.yml up -d
```

Between steps 1 and 3 the API keeps its open connections but cannot open new ones, so do them back to
back.

### 3b. `.env.prod` — API configuration

`DATABASE_URL` is injected by compose, so do **not** set it here. Required and notable vars:

| Var | Required | Notes |
|-----|----------|-------|
| `AUTH_SECRET` | ✅ | JWT signing key, ≥32 chars. Generate once, keep STABLE: `openssl rand -hex 32`. Changing it logs everyone out. |
| `SOLANA_WS_URL` | ✅ | `wss://mainnet.helius-rpc.com/?api-key=…` (Helius; the free plan works). |
| `WEB_ORIGINS` | ✅ | `https://binsight.thomasott.fr` — also binds the wallet sign-in (SIWS) origin and the WS origin allow-list. |
| `OWNER_ADDRESS` | recommended | Your wallet address: auto-whitelisted + flagged owner when it registers. |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` | optional | Web Push for installed PWAs. Generate once: `npx web-push generate-vapid-keys`. Must stay STABLE. |
| `SOLANA_RPS`, `SOLANA_GPA_RPS`, … | optional | RPC budget; defaults are the Helius free tier. |
| `HISTORY_DAYS` / `HISTORY_SINCE` | optional | History depth. |
| `BARK_KEY` | optional | The owner's [Bark](https://bark.day.app) push key — the fallback channel, used when no client (Mac app, open tab) is active. |

`NEXT_PUBLIC_API_WS_URL` is **baked at build time** (the browser needs it). It defaults to
`wss://binsight.thomasott.fr` in compose — override only if your hostname differs:
`NEXT_PUBLIC_API_WS_URL=wss://other.host docker compose -f docker-compose.prod.yml build web`.

## 4. TLS certificates (certbot)

One certificate per hostname. Get them **before** enabling the vhosts: each HTTPS server block names
its certificate files, so `nginx -t` fails while they don't exist. The nginx plugin answers the
HTTP-01 challenge itself without editing your config:

```bash
sudo certbot certonly --nginx -d binsight.thomasott.fr
sudo certbot certonly --nginx -d api.binsight.thomasott.fr
```

(Once the vhosts are live, their port-80 blocks also serve `/.well-known/acme-challenge/` from
`/var/www/certbot`, so `certbot certonly --webroot -w /var/www/certbot -d …` works too.) Renewal is
handled by the certbot systemd timer.

## 5. nginx vhosts

Install the **main vhost first**: it defines the `$connection_upgrade` map (http scope) that the API
vhost also uses. The API vhost must not redefine it (a duplicate `map` is a fatal nginx error), and
enabled on its own it fails `nginx -t` with `unknown "connection_upgrade" variable`.

```bash
sudo cp deploy/nginx/binsight.thomasott.fr.conf deploy/nginx/api.binsight.thomasott.fr.conf \
  /etc/nginx/sites-available/
sudo ln -s /etc/nginx/sites-available/binsight.thomasott.fr.conf /etc/nginx/sites-enabled/
sudo ln -s /etc/nginx/sites-available/api.binsight.thomasott.fr.conf /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

Both HTTPS blocks send `Strict-Transport-Security` (1 year, `includeSubDomains`). The files in
`sites-available` are copies: after changing a vhost in the repo, copy it again and reload.

## 6. First deploy

```bash
docker compose -f docker-compose.prod.yml up -d --build
docker compose -f docker-compose.prod.yml logs -f api    # wait for "Binsight API listening"
```

The API applies pending migrations, backfills rollups and starts the engine **before** it listens, so
`Binsight API listening` is the line that means boot succeeded. A failure logs
`Fatal startup error:` (or `Invalid configuration:` for a bad env) and the container restarts.

The database starts EMPTY. To create the owner account, open `https://binsight.thomasott.fr`, choose
**Create one with your wallet**, connect the `OWNER_ADDRESS` wallet, sign the one-time message and set
a password. After that, sign in everywhere (web and macOS app) with that address + password.

## 7. Updating (redeploy)

```bash
./deploy.sh
```
Pulls `main`, rebuilds the images and restarts. **The data volume is preserved.**

## 8. Data persistence & safety ⚠️

**All durable data lives in one place: the Postgres named volume `binsight_pgdata`** (compose project
`binsight`, volume `pgdata`). The API and web containers are **stateless on disk** (every byte of
state — positions, wallet flows, accounts, sessions, ingest cursors — is in Postgres; nothing is
written to a container filesystem). The Postgres user and database are still called `meteora` (the
project's former name); they identify the existing data, so they are not renamed.

What this means:

- **Preserved across** `up -d --build`, container restarts, VPS reboots, and
  `docker compose -f docker-compose.prod.yml down` (without `-v`). Rebuilding images never touches the
  volume.
- **DESTROYED only by** `docker compose ... down -v`, `docker volume rm binsight_pgdata`, or
  `docker volume prune`. **Never run these** unless you intend to wipe everything. `deploy.sh` never
  tears the stack down, so routine deploys are safe.
- **The dev stack is a separate project.** `docker-compose.yml` (`make db-up` / `make up` /
  `make down`) is named `binsight-dev`, with its own `binsight-dev_pgdata` volume, so running it from
  the same checkout never touches the production containers or volume.
- **Migrations are idempotent.** drizzle-orm records applied migrations in a `__drizzle_migrations`
  table and only runs pending ones, so a redeploy re-applies nothing. The one destructive migration
  (`0008`, the legacy email→wallet cutover) only runs on the **first** boot of a fresh database — where
  its `DELETE`s are no-ops — and never again. Open positions / flows / DLMM legs are keyed by wallet
  address and are not touched by it.
- **Restart behaviour:** `restart: unless-stopped` brings every container back after a crash or reboot.
  On start the API applies any pending migration, re-subscribes the Solana WebSocket, and **resumes
  on-chain ingest from the per-wallet cursors stored in Postgres** (`dlmm_ingest_cursor`,
  `wallet_flow_cursor`) — no re-download, no duplicates, no data loss.

### Backups (recommended — cron it)

```bash
docker compose -f docker-compose.prod.yml exec -T postgres \
  pg_dump -U meteora meteora | gzip > "binsight-$(date +%F).sql.gz"
```

Restore into a fresh volume:

```bash
gunzip -c binsight-YYYY-MM-DD.sql.gz | \
  docker compose -f docker-compose.prod.yml exec -T postgres psql -U meteora meteora
```

## 9. Ops

```bash
docker compose -f docker-compose.prod.yml ps
docker compose -f docker-compose.prod.yml logs -f api
docker compose -f docker-compose.prod.yml restart api
```
