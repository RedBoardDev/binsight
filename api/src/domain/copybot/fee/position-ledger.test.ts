/**
 * Copy-bot · Inc.4d — ledger derivation invariants (SPEC §9). These encode the WHY:
 *  - the base must be the OWNER's real lamport delta — a wrong owner index would attribute another account's
 *    movement (fabricated PnL), so the owner is resolved by VALUE and its sign decides in/out;
 *  - a missing owner yields NO row (never a fabricated zero that could mis-sum a base);
 *  - the resolution is robust to a v0 message's extra loaded (ALT) account keys appended after the static keys —
 *    the owner is still found by value and its balance still aligns by index;
 *  - only SOL-moving lifecycle kinds are ledger kinds (a swap/fee/buy is a wallet op, not a position leg).
 */
import { describe, expect, it } from 'vitest';
import { isLedgerKind, LEDGER_KINDS, ledgerRowFromMeta, sumLedgerBase } from './position-ledger';

const OWNER = 'OWNERpk';
const A = 'accountA';
const B = 'accountB';

describe('ledgerRowFromMeta — owner delta → in/out', () => {
  it('owner at index 0, positive delta (SOL returned: close/remove/claim) → lamports_in', () => {
    const row = ledgerRowFromMeta(
      OWNER,
      'close',
      { preBalances: [100, 5, 5], postBalances: [600, 5, 5] },
      [OWNER, A, B],
      'SIG1',
    );
    expect(row).toEqual({ kind: 'close', lamportsIn: 500, lamportsOut: 0, sig: 'SIG1' });
  });

  it('owner NOT at index 0, negative delta (SOL deposited: open/add) → lamports_out', () => {
    // The owner (fee-payer) is found by value at index 1 — never assumed to be index 0.
    const row = ledgerRowFromMeta(
      OWNER,
      'open',
      { preBalances: [7, 1000, 7], postBalances: [7, 300, 7] },
      [A, OWNER, B],
      'SIG2',
    );
    expect(row).toEqual({ kind: 'open', lamportsIn: 0, lamportsOut: 700, sig: 'SIG2' });
  });

  it('a zero delta yields a zero-movement row (a claim that netted the fee cost)', () => {
    const row = ledgerRowFromMeta(
      OWNER,
      'claim',
      { preBalances: [500], postBalances: [500] },
      [OWNER],
      'SIG3',
    );
    expect(row).toEqual({ kind: 'claim', lamportsIn: 0, lamportsOut: 0, sig: 'SIG3' });
  });

  it('owner absent from the account keys → no row (never fabricate a delta)', () => {
    const row = ledgerRowFromMeta(
      OWNER,
      'close',
      { preBalances: [1, 2], postBalances: [3, 4] },
      [A, B],
      'SIG4',
    );
    expect(row).toBeNull();
  });

  it('owner index beyond the balances array → no row (misaligned meta)', () => {
    const row = ledgerRowFromMeta(
      OWNER,
      'close',
      { preBalances: [1], postBalances: [1] },
      [A, OWNER],
      'SIG5',
    );
    expect(row).toBeNull();
  });

  it('a v0 message: owner delta is read correctly despite extra loaded (ALT) keys after the static keys', () => {
    // A v0 tx appends loaded-from-lookup addresses AFTER the static keys; the owner (static index 0) and its
    // pre/post balance still align by index — the extra trailing keys are irrelevant to the owner's delta.
    const row = ledgerRowFromMeta(
      OWNER,
      'remove',
      { preBalances: [200, 9, 9, 9], postBalances: [350, 9, 9, 9] },
      [OWNER, A, 'altKey1', 'altKey2'],
      'SIG6',
    );
    expect(row).toEqual({ kind: 'remove', lamportsIn: 150, lamportsOut: 0, sig: 'SIG6' });
  });
});

describe('sumLedgerBase — Σin − Σout', () => {
  it('sums a winning position to its positive base', () => {
    // deposited 1.0, added 0.4, closed 1.6, claimed 0.05 → base = (1.6 + 0.05) − (1.0 + 0.4) = 0.25 SOL.
    const rows = [
      { lamportsIn: 0, lamportsOut: 1_000_000_000 }, // open
      { lamportsIn: 0, lamportsOut: 400_000_000 }, // add
      { lamportsIn: 1_600_000_000, lamportsOut: 0 }, // close
      { lamportsIn: 50_000_000, lamportsOut: 0 }, // claim
    ];
    expect(sumLedgerBase(rows)).toBe(250_000_000n);
  });

  it('a losing position sums to a negative base (→ no fee upstream)', () => {
    const rows = [
      { lamportsIn: 0, lamportsOut: 1_000_000_000 },
      { lamportsIn: 400_000_000, lamportsOut: 0 },
    ];
    expect(sumLedgerBase(rows)).toBe(-600_000_000n);
  });

  it('an empty ledger sums to zero', () => {
    expect(sumLedgerBase([])).toBe(0n);
  });
});

describe('isLedgerKind — only SOL-moving lifecycle kinds', () => {
  it('accepts the five position lifecycle kinds', () => {
    for (const k of LEDGER_KINDS) expect(isLedgerKind(k)).toBe(true);
    expect(LEDGER_KINDS).toEqual(['open', 'add', 'remove', 'close', 'claim']);
  });

  it('rejects wallet-level ops (sell / buy / fee) and unknowns', () => {
    expect(isLedgerKind('sell')).toBe(false);
    expect(isLedgerKind('buy')).toBe(false);
    expect(isLedgerKind('fee')).toBe(false);
    expect(isLedgerKind('nonsense')).toBe(false);
  });
});
