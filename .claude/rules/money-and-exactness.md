---
paths:
  - "crates/core/**"
  - "crates/solana/**"
  - "crates/dlmm/**"
  - "crates/ledger/**"
  - "crates/store/**"
  - "crates/api/**"
  - "web/src/**"
---

# Money and exactness

Exact PnL is the promise of this project. One float in the wrong place breaks it silently.

## Golden rule: no floating point for money, ever

- Lamports are `Lamports(u64)`; raw token amounts are `RawTokenAmount(u128)`; signed deltas are `i128`. Use the unit
  newtypes, never bare integers, across function boundaries.
- Checked arithmetic only (`try_add`, `try_sub`, `checked_mul`…). An overflow is an error, not a wrap.
- DLMM prices are Q64.64 fixed point in `u128`, computed exactly like the on-chain program.
- Floats (`f32`/`f64`) are forbidden in `core`, `solana`, `dlmm`, `ledger` and `store`.
- Decimals are carried with the amount; a raw amount is never mistaken for a human amount. An unknown decimals value
  is an error or an `unavailable` figure, never a default.

## Storage

- Every amount is stored as `TEXT` holding a canonical decimal integer. SQLite tables are `STRICT`, so a `REAL` is
  rejected.
- `INTEGER` columns are only for bounded values below 2^63 (slots, timestamps, counters, versions).

## API and web

- Amounts travel as canonical decimal strings (`DecimalString`: no exponent, no trailing zeros, no `+`, no `-0`).
- Every figure carries its exactness: `complete`, `partial` (a lower bound, e.g. a token without a price),
  `estimated` (reconstructed history) or `unavailable`.
- **The web app never computes with amounts.** No `Number(amount)`, no arithmetic: it only formats strings with
  `Intl.NumberFormat`. Any figure the UI shows is computed by the server.
- One exception, to **draw** a chart: a single function (`Shared/Chart/Domain/plotValue.ts`) turns a decimal string
  into a number for a pixel position. A plotted number is never displayed, summed or compared; the figures next to a
  chart are still the server's strings.

## Definitions

The meaning of Net Worth, Real PnL, deposits ("apports") and position PnL is fixed in the `ledger` crate docs. A change
to a definition bumps the `calc_version` and comes with tests that pin the new numbers.
