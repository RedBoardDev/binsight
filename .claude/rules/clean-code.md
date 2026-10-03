# Clean code

These rules apply to every file in the repository, Rust and TypeScript alike. Readability beats cleverness: the code
is read far more often than it is written, often by someone who does not know the language well.

## Size and shape (enforced by `cargo xtask structure`)

- **A source file has at most 500 lines.** That is a hard ceiling, not a target. Aim for 250 or less; a file above
  300 lines needs a reason that would survive review.
- **One file, one need.** A file holds one concept: one type and its behaviour, one use case, one component. If you
  need "and" to describe what a file does, split it.
- **A folder holds at most 12 source files** (tests and generated files excluded). Beyond that, group the files into
  sub-modules by concept, never by technical kind (`helpers/`, `utils/`, `types/`, `misc/` are forbidden).
- Exceptions go only through `xtask/structure-allowlist.toml`, each with a written `reason`. An exception is a debt.

## Naming

- Names say what a thing **is** or **does** in the language of the domain: `RawTokenAmount`, `decode_claim_event`,
  `PositionCard`, `closedPositionsQuery`. No `data`, `info`, `manager`, `handler`, `util`, `tmp`, `foo2`.
- Whole words. Accepted abbreviations: `tx`, `rpc`, `id`, `url`, `api`, `sol`, `ws`, `sse`, `db`, `dlmm`, `pnl`.
- Booleans read as questions: `is_closed`, `has_fees`, `isPending`.
- A function name is a verb phrase; a type name is a noun phrase.
- The same concept has the same name everywhere (Rust, SQL, API, web). Do not rename on a layer boundary.

## Functions

- A function does one thing at one level of abstraction. If it mixes "decide" and "do I/O", split it.
- Keep functions short (aim for under 40 lines) and shallow (at most 3 levels of nesting). Prefer early returns over
  nested conditions.
- At most 4 parameters; beyond that, pass a named struct/object.
- No boolean flag parameters that switch behaviour: write two functions or pass an enum.
- Pure functions first. Side effects (network, disk, clock, randomness) live at the edges and are injected.

## Design

- Make illegal states unrepresentable: enums/tagged unions over flag combinations, newtypes over raw primitives.
- Parse, don't validate: convert untrusted input into a typed value once, at the boundary, then trust the type.
- No duplication of business rules. One rule lives in one place; everything else calls it.
- No dead code, no commented-out code, no speculative abstractions ("we might need it later"). Delete it; git remembers.
- No magic numbers: a named constant with a unit in its name (`HEARTBEAT_INTERVAL_SECS`).
- Errors are values with a meaning, not strings. Never swallow an error silently.

## Comments

- Code explains **what**; comments explain **why** — and only when the why is not obvious.
- Rust: every module starts with a `//!` paragraph ("this module does X; it does not do Y"); every public item has `///`
  docs. TypeScript: comments only for a trap (name the bug the next developer would introduce), a `TODO(#issue)`, or
  a required license header.
- The reasoning behind a change goes in the commit body, not in a comment.

## Dependencies

- Every new dependency needs a reason in the commit body (what it does that we should not write ourselves).
- Licenses must be permissive (MIT, Apache-2.0, BSD, ISC, Zlib, MPL-2.0…). Never GPL, AGPL or LGPL.

## Never commit

Secrets, API keys, `.env` files, personal wallet addresses, local notes or machine-specific paths.
