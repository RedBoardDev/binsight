import { describe, expect, it } from 'vitest';
import {
  canDetachAfterDrain,
  canTeardown,
  DUST_LAMPORTS,
  DUST_SOL,
  type PostDrainGateInput,
  type TeardownGateInput,
} from './teardown';

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

/** The post-force-close, pre-detach re-check. Note it takes NO `withdrawalAck` — a stale/sticky withdrawal ack is
 *  exactly what strands re-deposited funds (finding #141), so it cannot lift this guard; only key custody can. */
const DRAINED_CLEAR: PostDrainGateInput = {
  balanceLamports: 0,
  exportAck: false,
  dustLamports: DUST_LAMPORTS,
};

describe('canDetachAfterDrain — the post-drain fund re-check before the irreversible detach (finding #141)', () => {
  it('passes when the drained wallet is dust-empty and there is no key-export ack', () => {
    expect(canDetachAfterDrain(DRAINED_CLEAR)).toEqual({ ok: true });
  });

  it('passes at EXACTLY the dust ceiling (≤ dust is empty enough; only STRICTLY above strands funds)', () => {
    expect(canDetachAfterDrain({ ...DRAINED_CLEAR, balanceLamports: DUST_LAMPORTS })).toEqual({
      ok: true,
    });
  });

  it('REFUSES funds_remain above dust with no export ack — force-closed/re-deposited SOL would be stranded', () => {
    // This is the money-critical guard: without key custody, a soft-detach here permanently loses these funds.
    expect(canDetachAfterDrain({ ...DRAINED_CLEAR, balanceLamports: DUST_LAMPORTS + 1 })).toEqual({
      ok: false,
      reason: 'funds_remain',
    });
  });

  it('a key-EXPORT ack lifts the guard over ANY balance — the user can recover funds after the soft-detach', () => {
    expect(
      canDetachAfterDrain({ ...DRAINED_CLEAR, balanceLamports: 100 * DUST_LAMPORTS, exportAck: true }),
    ).toEqual({ ok: true });
  });
});
