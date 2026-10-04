# binsight

Self-hostable portfolio tracker for Meteora DLMM liquidity positions, with exact on-chain PnL.

[![CI](https://github.com/RedBoardDev/binsight/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/RedBoardDev/binsight/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

## Status

**Early development — not usable yet.** The foundation is in place (server, database, sign-in, live updates,
installable web app); tracking positions is not. There is no release yet, and no published image or binary:
the instructions below build the latest `main` from source.

## What it is

binsight runs on your own machine or server, for one owner who tracks a handful of Solana wallets. It reads
the chain through your own [Helius](https://www.helius.dev) API key and keeps everything in a single SQLite
database. One instance is one binary (or one container) with one data folder.

Today it offers:

- a password-protected web app, served by the binary itself;
- live updates from the server (the connection status is always visible);
- an installable app (PWA) on desktop and mobile;
- English, French and German.

Roadmap: exact, on-chain-verified PnL for DLMM positions (every figure says whether it is complete, partial,
estimated or unavailable), several wallets per instance, net worth and history, all within the Helius free
plan for about ten wallets.

## Quick start with Docker Compose

You need Git, Docker with Compose, and a Helius API key (the free plan is enough). Compose builds the image
from the repository, for the architecture of your machine.

```sh
git clone https://github.com/RedBoardDev/binsight.git
cd binsight
cat > .env <<'ENV'
BINSIGHT_PASSWORD='choose-a-long-password'
BINSIGHT_HELIUS_API_KEY='your-helius-api-key'
ENV
chmod 600 .env
docker compose up -d --build
```

Open <http://localhost:8080> and sign in with your password. The data lives in the `data` volume of the
`binsight-app` Compose project.

Keep the single quotes around the values: Compose reads them literally, while it would replace a `$` in an
unquoted or double-quoted value. Set `BINSIGHT_PORT` in `.env` to publish another port than 8080.

The port is published on this machine only (`127.0.0.1`). To reach binsight from other devices, read
[Exposing it safely](#exposing-it-safely) first.

You can also build the image yourself and run it under another name:

```sh
docker build -t binsight .
BINSIGHT_IMAGE=binsight docker compose up -d
```

## Configuration

binsight reads environment variables, then a `binsight.env` file, then its defaults (an environment variable
wins over the file). Invalid settings are all reported at once and the server does not start. The file holds
`NAME=value` lines; values are taken literally (a `$` is never replaced), and one with spaces goes in quotes.

| Variable | Required | Default | Meaning |
|---|---|---|---|
| `BINSIGHT_PASSWORD` | yes | — | The owner's password, 12 to 1024 characters. |
| `BINSIGHT_HELIUS_API_KEY` | yes | — | Your Helius API key. |
| `BINSIGHT_DATA_DIR` | no | `$XDG_DATA_HOME/binsight`, else `~/.local/share/binsight`; `/data` in the image | Where the database, its backups and the instance secrets live. |
| `BINSIGHT_BIND` | no | `127.0.0.1:8080`; `0.0.0.0:8080` in the image | The address and port the server listens on. |
| `BINSIGHT_PUBLIC_URL` | no | — | The address browsers use, such as `https://binsight.example.com` (no path). Set it behind a reverse proxy: it is trusted for cross-site checks, and `https` makes the session cookie `Secure`. |
| `BINSIGHT_CLIENT_IP_HEADER` | no | — | Behind a reverse proxy, the header it writes the client's address into (`X-Forwarded-For`, `X-Real-IP`…), so failed sign-ins are counted per client instead of all coming from the proxy. Set it only if every request goes through that proxy: a client reaching binsight directly could write any address there. |
| `BINSIGHT_LOG` | no | `info` | The log filter (`warn`, `debug`, `binsight_api=debug`…). |
| `BINSIGHT_LOG_FORMAT` | no | `pretty` | `pretty` or `json`. |
| `BINSIGHT_CONFIG_FILE` | no | `$XDG_CONFIG_HOME/binsight/binsight.env`, else `~/.config/binsight/binsight.env` | The configuration file (also `--config-file`). A missing file at the default path is fine. |

`binsight admin config` shows the effective configuration and where each value comes from, without the
secrets.

## Running without Docker

There are no release binaries yet: build one from source (below), then:

```sh
binsight init   # asks for your Helius API key and password, writes ~/.config/binsight/binsight.env (mode 0600)
binsight run    # serves http://127.0.0.1:8080 until Ctrl-C or SIGTERM
```

`binsight --help` and `binsight admin --help` list the other commands (configuration, database status,
backup, signing every session out).

## Exposing it safely

binsight speaks plain HTTP and has a single password: do not expose its port to the internet directly. Put it
behind a reverse proxy with HTTPS, or reach it over a private network such as Tailscale. Installing the PWA
from another device also needs HTTPS. With [Caddy](https://caddyserver.com):

```
binsight.example.com {
    reverse_proxy 127.0.0.1:8080
}
```

Then set `BINSIGHT_PUBLIC_URL=https://binsight.example.com`, and `BINSIGHT_CLIENT_IP_HEADER=X-Forwarded-For` (Caddy
writes the client's address there) so that failed sign-ins are slowed down per client.

With Docker Compose, the port is published on the loopback interface by default, which is what a reverse
proxy on the same machine needs. To publish it on every interface instead (a proxy on another machine, a
private network), set it deliberately in `.env`:

```sh
BINSIGHT_PUBLISH_ADDRESS='0.0.0.0'
```

Docker's published ports bypass most host firewalls (ufw included), so only do this on a network you trust.

## Updating and backups

From the clone:

```sh
git pull && docker compose up -d --build
```

Before applying a database migration, binsight backs the database up automatically into `backups/` in its
data folder (the last three are kept), and it refuses to open a database written by a newer version. To back
up everything, copy the data folder (or the `data` volume) while binsight is stopped.

## Building from source

You need Rust (rustup installs the version pinned in `rust-toolchain.toml`), Node.js 24 (`nvm install` reads
`.nvmrc`), pnpm 12 (`npm install --global pnpm@12.8.1`) and [just](https://just.systems).

```sh
just setup   # git hooks and web dependencies
just build   # the web app, then target/release/binsight, which embeds it
```

Or build the image: `docker build -t binsight .`

## Contributing, security and license

- Contributions are welcome: read [CONTRIBUTING.md](CONTRIBUTING.md).
- Report vulnerabilities privately, as explained in [SECURITY.md](SECURITY.md).
- binsight is released under the [MIT License](LICENSE). Every instance serves the license notices of the
  third-party software it contains, the Rust crates of the server and the packages of the web app, at
  `/third-party-licenses.txt`.
