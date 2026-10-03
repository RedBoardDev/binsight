---
paths:
  - "crates/api/**"
  - "openapi/**"
---

# HTTP API

## Contract

- REST under `/api/v1`. Compatible additions stay in v1; a breaking change means `/api/v2` alongside.
- The OpenAPI 3.1 contract is **generated from the Rust code** (`utoipa`) and committed as `openapi/v1.json`. Never edit
  it by hand: change the code, run `just openapi`. CI fails if the committed file is stale.
- Every operation has a stable `operationId` (the web client and the macOS app depend on them).
- `api` only talks to `engine`; it never reaches `store` or `chain`.

## JSON

- `snake_case` fields; enums as `snake_case` strings; timestamps RFC 3339 UTC; Solana ids in base58.
- Lists: `{ "items": [...], "next_cursor": null | "…" }` with an opaque cursor.
- Amounts: `Money { amount: DecimalString, unit }`; figures: `Figure { value: Money, exactness }`. No JSON number for an
  amount or a ratio.

## Errors

- Body: `{"error":{"code":"…","message":"…","request_id":"…"}}`. `code` is a stable enum (`ErrorCode`) documented in
  the contract and is the translation key on the clients; `message` is English, for debugging, never shown to users.
- 5xx responses never leak internal error text; they are logged with the `request_id`. Every response carries
  `x-request-id`.
- Unknown `/api/*` routes return JSON 404/405, never the web app's `index.html`.

## Auth

- One owner password from the configuration. Constant-time comparison, signed `HttpOnly` `SameSite=Lax` session
  cookie, CSRF protection on state-changing requests, progressive delay (`429` + `Retry-After`) after failed logins.

## Live events (SSE)

- `GET /api/v1/events`; the `event:` name equals the `type` of the `LiveEvent` tagged union registered in the contract.
- A status event is sent as soon as a client connects; then a heartbeat every 15 s. SSE responses are never compressed.
