import { describe, expect, it } from 'vitest';
import { canTeardown, DUST_LAMPORTS, DUST_SOL, type TeardownGateInput } from './teardown';

/** A clean, deletable account: nothing open, dust-empty, no ack needed. The base each case perturbs one field of. */
const CLEAR: TeardownGateInput = {
  openMirrorCount: 0,
  balanceLamports: 0,
  withdrawalAck: false,
  exportAck: false,
  dustLamports: DUST_LAMPORTS,
};

describe('canTeardown — the irreversible-delete fund gate (SPEC §2.4)', () => {
  it('passes when the account is clear: no open mirrors, dust-empty, no ack', () => {
    expect(canTeardown(CLEAR)).toEqual({ ok: true });
  });

  it('passes at EXACTLY the dust ceiling (≤ dust is empty enough; only STRICTLY above refuses)', () => {
    expect(canTeardown({ ...CLEAR, balanceLamports: DUST_LAMPORTS })).toEqual({ ok: true });
  });

  it('REFUSES with open mirrors and no ack — capital is locked in positions (never delete over it)', () => {
    expect(canTeardown({ ...CLEAR, openMirrorCount: 1 })).toEqual({
      ok: false,
      reason: 'open_mirrors',
    });
  });

  it('REFUSES with a balance above dust and no ack — real SOL would be stranded by the delete', () => {
    expect(canTeardown({ ...CLEAR, balanceLamports: DUST_LAMPORTS + 1 })).toEqual({
      ok: false,
      reason: 'funds_remain',
    });
  });

  it('a completed WITHDRAWAL lifts BOTH guards (the user took custody) — passes even with open + funds', () => {
    expect(
      canTeardown({
        ...CLEAR,
        openMirrorCount: 3,
        balanceLamports: 10 * DUST_LAMPORTS,
        withdrawalAck: true,
      }),
    ).toEqual({ ok: true });
  });

  it('a confirmed key-EXPORT ack lifts BOTH guards (the user can recover the wallet) — passes over funds', () => {
    expect(
      canTeardown({
        ...CLEAR,
        openMirrorCount: 2,
        balanceLamports: 5 * DUST_LAMPORTS,
        exportAck: true,
      }),
    ).toEqual({ ok: true });
  });

  it('open mirrors are checked BEFORE the balance (locked capital is the stronger refusal)', () => {
    // Both guards trip; the mirror refusal is reported (deterministic, most fund-critical).
    expect(
      canTeardown({ ...CLEAR, openMirrorCount: 1, balanceLamports: DUST_LAMPORTS + 1 }),
    ).toEqual({ ok: false, reason: 'open_mirrors' });
  });

  it('DUST_SOL is the documented 0.05 SOL floor', () => {
    expect(DUST_SOL).toBe(0.05);
    expect(DUST_LAMPORTS).toBe(50_000_000);
  });
});
