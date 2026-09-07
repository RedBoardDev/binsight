---
name: copybot-onchain-test
description: On-chain regression test protocol for the copy-bot (leader-test → copier-test, real signatures). Invoke after ANY change touching detection, tx-building, the bus, the brain/coffre, sizing, or the lifecycle handlers (open/add/remove/close/claim/sell). Provides the off-chain gate, the live test matrix, the robustness "killer" tests, the diag tools, and the pass criteria — so we never regress.
---

# Copy-bot on-chain test protocol

Two test layers: an **off-chain gate** (fast, run every change) and an **on-chain matrix** (real signatures on the two test wallets). Grow the matrix as features land.

## Wallets & infra (constants)
- leader-test (driver): `6nhwvUjRe5a3KC9BmURxMuaf9EQ7MUHDnfsQ2NfVQjc9`
- copier-test (the bot): `Ybbt2Td4TjxwpzvuicbP9ANizBwAJzqjuRmRrvDh9zz`
- Redis `meteora-redis:6385`, Postgres `:5435` (tables: executions, copy_positions, leader_activity, copy_decisions).
- Pool: a **SOL-paired, volatile** pool (fees + residual). Last used: `Hzsx5pCjvPAYhXr6vhAV35C7KSTfacvyQEcE6P3PjRep` (token/SOL).
- Sandbox note: Jupiter + Meteora pairs-API are UNREACHABLE here → residual sell fails → ALERT fires (graceful; the sell completes on a real machine). RPC (Helius) works.

## 0. Off-chain gate — run FIRST, every change (no funds)
```
cd api && yarn typecheck && yarn vitest run && yarn bot:firewall
```
Green = pure logic (sizing, reanchor, reconcile, position-adjust, residual-sell), Wall B, contracts, the no-miss detector, and the bus envelope are regression-free. **Do not go on-chain if this is red.**

## 1. Start the bot (2 processes, real signing)
```
cd api && yarn bot:build
# vault (only key holder):
SIGNING_ENABLED=true MAX_TRADE_SOL=0.1 yarn bot:coffre            > coffre.log 2>&1 &
# brain (watches leader-test; LOG_LEVEL=debug shows the full decision flow):
COPYBOT_LEADER=6nhwvUjRe5a3KC9BmURxMuaf9EQ7MUHDnfsQ2NfVQjc9 COPIER_BALANCE_SOL=0.37 yarn bot:brain > brain.log 2>&1 &
```
Wait for `🔐 vault started` and `replay done — switching to live`.

### 1.1 Entry filters (shadow-log) — env-driven on the BRAIN, default OFF + shadow ON
Filters gate the OPEN only (never an exit). On the brain process:
- `COPYBOT_FILTER_SHADOW=true` (default): evaluate + LOG the verdict but DO NOT block — safe to observe live.
  Set `COPYBOT_FILTER_SHADOW=false` to ENFORCE (the filtered open is skipped).
- Thresholds (unset = OFF): `COPYBOT_FILTER_MIN_ORGANIC_SCORE`, `COPYBOT_FILTER_MIN_TOKEN_AGE_HOURS`,
  `COPYBOT_FILTER_MIN_MARKET_CAP_USD`, `COPYBOT_FILTER_MIN_24H_VOLUME_USD`, `COPYBOT_FILTER_MAX_PRICE_CHANGE_PCT`,
  `COPYBOT_FILTER_MIN_HOLDERS`, `COPYBOT_FILTER_MIN_PRICE_RANGE_PCT`. Toggles:
  `COPYBOT_FILTER_SINGLE_POOL_PER_TOKEN=true`, `COPYBOT_FILTER_IGNORED_TOKENS=mint1,mint2`.
  `JUPITER_TOKEN_API_KEY` optional (otherwise the keyless lite-api is used).
- Observe in the brain log: `🧪 entry filters loaded` at boot, then per open `👻 filter shadow: WOULD skip {reason}`
  (shadow) / `🚧 open filtered → skip {reason}` (enforce) / a normal open when it passes.
- Sandbox note: data filters (organic/mcap/age/volume/holders) need Jupiter reachable → validate on a real
  machine; instant filters (ignored / single-pool / min-price-range) work without any external call.
- Example (shadow, organic-score 50): `COPYBOT_FILTER_MIN_ORGANIC_SCORE=50 COPYBOT_LEADER=… yarn bot:brain`.

## 2. Live test matrix (drive leader-test, verify the bot mirrors)
`P=Hzsx5pCjvPAYhXr6vhAV35C7KSTfacvyQEcE6P3PjRep`

| action | leader-control command | expect (brain log) | verify |
|---|---|---|---|
| OPEN | `yarn bot:leader open --pool=$P --sol=0.12 [--strategy=spot\|bidask\|curve]` | `event routed` open → `🔨 handleOpen` → `📤 cmd:sign published`; coffre `🚀 signed + landed` open | copy on-chain + **diag-verify-copy** <0.5% econ |
| ADD | (with a position open) `yarn bot:leader add --pool=$P --sol=0.05` | `event routed` (deposit, tracked) → `➕ proportional add published` | mirror `sizeSol` grew; coffre landed `add` |
| REMOVE | `yarn bot:leader remove --pool=$P --bps=3000` | `event routed` (withdraw) → `➖ proportional remove published` | coffre landed `remove`; copy liquidity trimmed ~30% |
| CLAIM | `yarn bot:leader claim --pool=$P` (needs accrued fees) | `event routed` claim → `cmd:sign` claim | coffre landed `claim` |
| CLOSE | `yarn bot:leader close --pool=$P` | `event routed` close → `🧠 build+publish` close (sub-second); coffre landed close | copy CLOSED; residual sell triggers (ALERT if Jupiter unreachable) |

## 3. Robustness "killer" tests (must pass)
- **No-dormant while DOWN**: open → `kill` the brain → `close` leader while down → restart brain → boot `♻️ mirrors reloaded` → `🛟 failsafe re-close` closes the orphan (~1.5s). Verify the copy is CLOSED on-chain.
- **Fresh-open vs reconcile RACE (regression — found live 2026-06)**: a reconcile sweep firing within ~1s of a fresh open used to read the not-yet-indexed copy as "gone" → `markClosed` → forgot the mirror → **silent dormant** (worsened because an empty `tracked` then short-circuited the orphan check). FIX: open-grace (`RECONCILE_OPEN_GRACE_MS`, mirror `openedAt` persisted) — the reconcile concludes NOTHING about a copy opened `< grace` ago; orphan detection runs even when `tracked` is empty. Covered off-chain by `reconciliation.test.ts` › "open-grace"; the reconcile must NEVER `markClosed`/forget a copy whose only evidence is enumerator-absence right after open. If a copy is ever wrongly forgotten, re-track it (`UPDATE copy_positions SET status='open', closed_at=NULL WHERE leader_position=…`) then close the leader → the failsafe `reClose` closes it.
- **Rapid open→close**: `open` then immediately `close` → FIFO ordering holds (copy-open lands before copy-close), no race.
- **Over-max**: a copy size > `MAX_TRADE_SOL` → coffre `⛔ rejected over_max_trade` (no oversized position).
- **Cleanup discipline**: ALWAYS `close` every leader position at the end (recover funds; rent refunds on close).

## 4. Diag tools
From `api/`. tsx (SDK-free) vs bundled (`.cjs`, needs the SDK):
- `node --import tsx --env-file=../.env scripts/check-balances.ts` — wallet SOL balances.
- `node --import tsx --env-file=../.env scripts/diag-leader-activity.ts [leader]` — real leader event mix.
- `node --import tsx --env-file=../.env scripts/diag-detect.ts <sig>` — what detection classifies for a sig.
- `node --env-file=../.env dist/copybot/scripts/diag-verify-copy.cjs <pool> <leaderPos> <copyOwner> <copyPos>` — economic shape fidelity (values BOTH legs; <0.5% = faithful).
- `node --env-file=../.env dist/copybot/scripts/diag-build.cjs` — time the open build path.
- `node --import tsx --env-file=../.env scripts/diag-redis.ts` — cmd:sign stream + coffre group state.

## 5. Pass criteria
- Every leader action mirrored on copier-test (open/add/remove/close/claim).
- Shape fidelity <0.5% economic (diag-verify-copy).
- Close sub-second; **zero dormant positions**; funds recovered.
- Off-chain suite green; firewall clean (coffre imports neither the DLMM SDK nor the keypair from the brain side).

## Latency reference (WiFi; ~3-4× faster on a colocated RPC)
OPEN brainMs ~700ms + coffre ~160ms (~1.0s e2e). CLOSE brainMs ~335ms + coffre ~120ms (~0.6s e2e).
