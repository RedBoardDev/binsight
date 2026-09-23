# @binsight/solana-core

Solana + Meteora DLMM primitives, with no persistence, no wire contract and no application policy — so
the API and any other service on the same chain access (a copy-trading bot, for one) share one
implementation of the parts that are costly to get right on a free Helius plan.

- `rpc/` — plan-aware RPC lanes (`createRpcLanes`: a live and a backfill `Connection` sharing one
  budget), the rate limiter, the credit meter and code-path attribution, `getProgramAccountsV2` /
  `getTokenAccountsByOwnerV2` builders.
- `stream/` — the per-wallet `logsSubscribe` stream (dedup, resubscribe, liveness probe) and its Helius
  transport. A trigger only: it has no replay, so correctness must rest on a periodic poll.
- `tx/` — a `getParsedTransaction` result reduced to the wallet's SOL flow and clean swap legs.
- `dlmm/` — DLMM account layouts, the IDL-driven event decoder, the instruction classifier, strategy
  decoding and position valuation.

The package ships TypeScript sources (`exports` → `src/index.ts`); consumers bundle it (the API's tsup
config lists it in `noExternal`).

```sh
yarn workspace @binsight/solana-core typecheck
yarn workspace @binsight/solana-core test
```
