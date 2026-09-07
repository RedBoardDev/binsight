/**
 * Copy-bot · Inc.4d — the per-position execution LEDGER derivation (PURE: no I/O, no SDK, no DB).
 *
 * SPEC §9: the fee base is the bot's own execution ledger for a position — (withdrawn + claimed) − deposited, in
 * lamports, exact, with NO dependency on the stats engine. Each SOL-moving position tx (open/add/remove/close/claim)
 * contributes one ledger row, derived from the OWNER account's lamport balance delta in the confirmed tx meta
 * (`preBalances`/`postBalances`): the delta captures reality (it even includes the tx fee the owner paid, so the
 * summed base is the TRUE net lamport change over the position's life).
 *
 * The account-key layout differs between a legacy and a v0 message, but the owner is always the fee-payer in the
 * STATIC keys — so the caller resolves the ordered static keys (see the coffre extraction) and passes them here; we
 * find the owner's index by value (never assume index 0) and read its delta. Fully unit-tested with synthetic meta.
 */

/** The SOL-moving position lifecycle kinds that produce a ledger row (a swap/fee/buy is a wallet op, not a leg). */
export const LEDGER_KINDS = ['open', 'add', 'remove', 'close', 'claim'] as const;
export type LedgerKind = (typeof LEDGER_KINDS)[number];

/**
 * Every kind that CONTRIBUTES to a position's fee base (#140). The 5 position legs (LEDGER_KINDS) PLUS the two
 * wallet-level SOL ops the brain now attributes to a position: the token `buy` funding a two-sided open/reshape, and
 * the residual `sell` at close. `buy`/`sell` are deliberately NOT in LEDGER_KINDS / `isLedgerKind` — the coffre's
 * confirm worker must still SKIP them (a swap is not a position leg it writes on land); the brain appends those two
 * rows itself at open/sell-confirm. `sumLedgerBase` is kind-agnostic, so all seven fold into the base identically.
 */
export type LedgerRowKind = LedgerKind | 'buy' | 'sell';

/** Whether a sign kind moves position SOL and therefore contributes to the fee base. Pure. */
export function isLedgerKind(kind: string): kind is LedgerKind {
  return (LEDGER_KINDS as readonly string[]).includes(kind);
}

/** The subset of tx meta the ledger derivation reads — the owner's pre/post lamport balances, indexed by account. */
export interface LedgerMeta {
  preBalances: ReadonlyArray<number>;
  postBalances: ReadonlyArray<number>;
}

/** One derived ledger movement: `lamportsIn` = SOL returned to the owner, `lamportsOut` = SOL the owner deposited. */
export interface LedgerRow {
  kind: LedgerRowKind; // a position leg, OR a buy/sell the brain attributes to the position (#140)
  lamportsIn: number;
  lamportsOut: number;
  sig: string;
}

/** A minimal account-key shape: anything exposing `toBase58()` (a web3.js `PublicKey`, or a test double). Structural
 *  so this module stays SDK-free — the caller passes real `PublicKey`s; we only ever read `.toBase58()`. */
export interface AccountKeyLike {
  toBase58(): string;
}

/** A tx message exposing its ordered account keys — legacy (`accountKeys`) or v0 (`staticAccountKeys`). */
export interface AccountKeyedMessage {
  staticAccountKeys?: ReadonlyArray<AccountKeyLike>;
  accountKeys?: ReadonlyArray<AccountKeyLike>;
}

/**
 * The ordered account keys of a confirmed tx as base58, layout-robust across a legacy and a v0 message. The owner
 * (fee-payer) is always among the STATIC keys and aligns by index with `pre/postBalances`, so the static keys
 * suffice to locate the owner's lamport delta — the loaded (ALT) addresses of a v0 tx are irrelevant here. Pure.
 * Shared by the coffre (confirm worker: open/add/remove/close/claim rows) AND the brain (sell-confirm row).
 */
export function accountKeysOf(message: AccountKeyedMessage): string[] {
  const keys = message.staticAccountKeys ?? message.accountKeys ?? [];
  return keys.map((k) => k.toBase58());
}

/**
 * Derive a ledger row from a confirmed tx's meta by the OWNER's balance delta. Returns `null` (no row) when the
 * owner is absent from the account keys or its balances are missing — a defensive skip, never a fabricated row.
 * A positive delta (remove/close/claim returned SOL) → `lamportsIn`; a negative delta (open/add deposited SOL) →
 * `lamportsOut`. Layout-agnostic: the owner is located by value in `accountKeys` (legacy or v0 static keys). Pure.
 */
export function ledgerRowFromMeta(
  ownerPk: string,
  kind: LedgerRowKind,
  meta: LedgerMeta,
  accountKeys: ReadonlyArray<string>,
  sig: string,
): LedgerRow | null {
  const ownerIndex = accountKeys.indexOf(ownerPk);
  if (ownerIndex < 0) return null; // owner not in the tx's account keys → cannot attribute a delta
  const pre = meta.preBalances[ownerIndex];
  const post = meta.postBalances[ownerIndex];
  if (pre === undefined || post === undefined) return null; // balances misaligned with the keys → no row
  // Net lamport change of the owner (fee-payer). Includes the tx fee it paid — that IS reality, so the summed base
  // is the true net over the position's life (SPEC §9 "exact, lamport-level").
  const delta = post - pre;
  return {
    kind,
    lamportsIn: delta > 0 ? delta : 0,
    lamportsOut: delta < 0 ? -delta : 0,
    sig,
  };
}

/** Sum a position's ledger rows into its realized base in lamports: `Σlamports_in − Σlamports_out`. Pure. */
export function sumLedgerBase(
  rows: ReadonlyArray<{ lamportsIn: number; lamportsOut: number }>,
): bigint {
  let base = 0n;
  for (const r of rows) base += BigInt(r.lamportsIn) - BigInt(r.lamportsOut);
  return base;
}
