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
  kind: LedgerKind;
  lamportsIn: number;
  lamportsOut: number;
  sig: string;
}

/**
 * Derive a ledger row from a confirmed tx's meta by the OWNER's balance delta. Returns `null` (no row) when the
 * owner is absent from the account keys or its balances are missing — a defensive skip, never a fabricated row.
 * A positive delta (remove/close/claim returned SOL) → `lamportsIn`; a negative delta (open/add deposited SOL) →
 * `lamportsOut`. Layout-agnostic: the owner is located by value in `accountKeys` (legacy or v0 static keys). Pure.
 */
export function ledgerRowFromMeta(
  ownerPk: string,
  kind: LedgerKind,
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
