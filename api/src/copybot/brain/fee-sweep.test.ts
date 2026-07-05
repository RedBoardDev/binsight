/**
 * Copy-bot · Inc.4d — fee-sweep invariants (SPEC §9). These encode the WHY:
 *  - a pending fee is published to the OWNING user's runtime with the exact lamports (the sweep must not sign nor
 *    move funds itself — it delegates to the tenant that owns the wallet);
 *  - every publish attempt is COUNTED before the publish, so a failing publish still records the try and the row
 *    stays retryable (a fee is retried each sweep until it lands, never dropped);
 *  - a publish failure is swallowed — a fee failure must NEVER throw out of the sweep (it must never block a close);
 *  - a fee whose user runtime is not booted is skipped (left pending, retried later) — never lost, never mis-signed;
 *  - the sweep passes the CURRENTLY-BOOTED userIds to listPending, so un-bootable fees are excluded at the query
 *    level and can never head-of-line-block a live user's fee out of the bounded batch (finding #155);
 *  - a doomed transfer is CAPPED: past FEE_SWEEP_MAX_ATTEMPTS published attempts the sweep stops re-signing it and
 *    escalates LOUD, so it can never re-sign every tick forever (idx44).
 */
import { pino } from 'pino';
import { describe, expect, it, vi } from 'vitest';
import {
  type ClosedFeeBackstopDeps,
  FEE_SWEEP_MAX_ATTEMPTS,
  type FeeSweepDeps,
  runClosedFeeBackstop,
  runFeeSweep,
  type SweepableFee,
} from './fee-sweep';

const log = pino({ level: 'silent' });

function depsOf(over: Partial<FeeSweepDeps> & { pending?: SweepableFee[] } = {}): {
  deps: FeeSweepDeps;
  publishFee: ReturnType<typeof vi.fn>;
  bump: ReturnType<typeof vi.fn>;
} {
  const publishFee = vi.fn(async () => {});
  const bump = vi.fn(async () => {});
  const rt = { publishFee };
  const deps: FeeSweepDeps = {
    log,
    listPending: async () => over.pending ?? [],
    batchLimit: 50,
    bootedUserIds: () => ['U'], // the default fee's owner is booted
    runtimeFor: over.runtimeFor ?? (() => rt),
    bumpAttempts: bump,
    ...over,
  };
  return { deps, publishFee, bump };
}

const fee = (over: Partial<SweepableFee> = {}): SweepableFee => ({
  userId: 'U',
  ourPosition: 'POS',
  feeLamports: 50_000_000,
  attempts: 0,
  ...over,
});

describe('runFeeSweep', () => {
  it('publishes a pending fee to the owning runtime with the exact lamports + counts the attempt', async () => {
    const { deps, publishFee, bump } = depsOf({ pending: [fee({ feeLamports: 42_000_000 })] });
    await runFeeSweep(deps);
    expect(publishFee).toHaveBeenCalledWith('POS', 42_000_000);
    expect(bump).toHaveBeenCalledWith('U', 'POS');
  });

  it('counts the attempt BEFORE publishing, so a FAILED publish still records the try (retryable)', async () => {
    const publishFee = vi.fn(async () => {
      throw new Error('coffre offline');
    });
    const bump = vi.fn(async () => {});
    const deps = depsOf({
      pending: [fee()],
      runtimeFor: () => ({ publishFee }),
      bumpAttempts: bump,
    }).deps;
    await expect(runFeeSweep(deps)).resolves.toBeUndefined(); // never throws out of the sweep
    expect(bump).toHaveBeenCalledTimes(1); // the attempt was counted even though the publish failed
  });

  it("a fee whose user runtime isn't booted is left pending (no publish, no attempt) — retried next sweep", async () => {
    const { deps, publishFee, bump } = depsOf({ pending: [fee()], runtimeFor: () => undefined });
    await runFeeSweep(deps);
    expect(publishFee).not.toHaveBeenCalled();
    expect(bump).not.toHaveBeenCalled();
  });

  it('no pending fees (e.g. no operator sink → nothing pending) → a clean no-op', async () => {
    const { deps, publishFee } = depsOf({ pending: [] });
    await runFeeSweep(deps);
    expect(publishFee).not.toHaveBeenCalled();
  });

  it('passes the currently-booted userIds + batch limit to listPending (query-level exclusion of un-bootable fees, finding #155)', async () => {
    const listPending = vi.fn(async () => [] as SweepableFee[]);
    const { deps } = depsOf({ bootedUserIds: () => ['A', 'B'], listPending });
    await runFeeSweep(deps);
    expect(listPending).toHaveBeenCalledWith(['A', 'B'], 50); // the booted set, not just the limit, reaches the query
  });

  it("sweeps a live user's newer fee despite older un-bootable pending rows — no head-of-line block (finding #155)", async () => {
    const publishFee = vi.fn(async () => {});
    const bump = vi.fn(async () => {});
    // The store filters to booted users at the SOURCE and applies the bound AFTER; model that faithfully here.
    const all: SweepableFee[] = [
      fee({ userId: 'GONE', ourPosition: 'OLD' }), // oldest, but 'GONE' has no booted runtime
      fee({ userId: 'LIVE', ourPosition: 'NEW', feeLamports: 7_000_000 }),
    ];
    const deps: FeeSweepDeps = {
      log,
      bootedUserIds: () => ['LIVE'],
      listPending: async (booted, limit) =>
        all.filter((f) => booted.includes(f.userId)).slice(0, limit),
      batchLimit: 50,
      runtimeFor: (userId) => (userId === 'LIVE' ? { publishFee } : undefined),
      bumpAttempts: bump,
    };
    await runFeeSweep(deps);
    expect(publishFee).toHaveBeenCalledTimes(1);
    expect(publishFee).toHaveBeenCalledWith('NEW', 7_000_000); // the live fee is published…
    expect(bump).toHaveBeenCalledWith('LIVE', 'NEW'); // …and its attempt counted
    expect(bump).toHaveBeenCalledTimes(1); // the un-bootable OLD row never entered the batch
  });

  it('idx44: a fee AT the retry cap is NOT re-signed and is escalated LOUD (a doomed transfer stops re-signing every tick forever)', async () => {
    // WHY: the attempts counter was written but never read to cap — a doomed transfer (bad sink, persistent balance
    // failure) re-signed forever, burning a signer slot each tick with no escalation. At the cap we skip + alert.
    const errSpy = vi.spyOn(log, 'error');
    const { deps, publishFee, bump } = depsOf({
      pending: [fee({ attempts: FEE_SWEEP_MAX_ATTEMPTS })],
    });
    try {
      await runFeeSweep(deps);
      expect(publishFee).not.toHaveBeenCalled(); // re-signing STOPPED — no more doomed transfers
      expect(bump).not.toHaveBeenCalled(); // no further attempt counted (the row is frozen at the cap, not churned)
      expect(errSpy).toHaveBeenCalledTimes(1); // escalated LOUD so a stuck fee is observable
    } finally {
      errSpy.mockRestore();
    }
  });

  it('idx44: a fee ONE attempt below the cap is still published (the cap is a ceiling, never an early abandonment of a retryable fee)', async () => {
    const { deps, publishFee, bump } = depsOf({
      pending: [fee({ attempts: FEE_SWEEP_MAX_ATTEMPTS - 1, feeLamports: 9_000_000 })],
    });
    await runFeeSweep(deps);
    expect(publishFee).toHaveBeenCalledWith('POS', 9_000_000); // still retried
    expect(bump).toHaveBeenCalledWith('U', 'POS'); // and the attempt counted (reaching the cap on THIS tick)
  });
});

/**
 * Copy-bot · #140 — the no-miss fee backstop. These encode the WHY:
 *  - the moved fee trigger (sell-confirm) introduced a "never assessed" tail (a close-sell that failed/never
 *    confirmed) — the backstop assesses any CLOSED-and-unfeed position via its owning runtime, so no closed
 *    position is ever left permanently unassessed;
 *  - it queries with `closedBeforeMs = now − grace`, so a normal close-sell's EXACT assess wins first (a fee that
 *    lands a few minutes late is fine — racing the sell would assess prematurely, missing its proceeds row);
 *  - an assess failure is swallowed (a fee must never block a close) and the pass continues to the next position;
 *  - a position whose runtime is torn down is skipped (TOCTOU) and left for the next pass — never lost.
 */
describe('runClosedFeeBackstop', () => {
  function bdepsOf(
    over: Partial<ClosedFeeBackstopDeps> & {
      closed?: Array<{ userId: string; ourPosition: string }>;
    } = {},
  ): { deps: ClosedFeeBackstopDeps; assessFee: ReturnType<typeof vi.fn> } {
    const assessFee = vi.fn(async () => {});
    const rt = { assessFee };
    const deps: ClosedFeeBackstopDeps = {
      log,
      listClosedWithoutFee: async () => over.closed ?? [],
      batchLimit: 25,
      graceMs: 300_000,
      bootedUserIds: () => ['U'],
      runtimeFor: over.runtimeFor ?? (() => rt),
      nowMs: () => 1_000_000_000,
      ...over,
    };
    return { deps, assessFee };
  }

  it('assesses each CLOSED-without-fee position via its OWNING runtime', async () => {
    const { deps, assessFee } = bdepsOf({
      closed: [
        { userId: 'U', ourPosition: 'P1' },
        { userId: 'U', ourPosition: 'P2' },
      ],
    });
    await runClosedFeeBackstop(deps);
    expect(assessFee).toHaveBeenCalledWith('P1');
    expect(assessFee).toHaveBeenCalledWith('P2');
  });

  it('queries with closedBeforeMs = now − grace (a position closed WITHIN the grace is not re-assessed early)', async () => {
    const listClosedWithoutFee = vi.fn(
      async () => [] as Array<{ userId: string; ourPosition: string }>,
    );
    const { deps } = bdepsOf({
      listClosedWithoutFee,
      bootedUserIds: () => ['A'],
      graceMs: 300_000,
      nowMs: () => 1_000_000_000,
    });
    await runClosedFeeBackstop(deps);
    expect(listClosedWithoutFee).toHaveBeenCalledWith(['A'], 25, 1_000_000_000 - 300_000);
  });

  it('a failing assess is SWALLOWED (never blocks a close) and the pass continues to the next position', async () => {
    const assessFee = vi.fn(async () => {
      throw new Error('db blip');
    });
    const { deps } = bdepsOf({
      closed: [
        { userId: 'U', ourPosition: 'P1' },
        { userId: 'U', ourPosition: 'P2' },
      ],
      runtimeFor: () => ({ assessFee }),
    });
    await expect(runClosedFeeBackstop(deps)).resolves.toBeUndefined();
    expect(assessFee).toHaveBeenCalledTimes(2); // continued past the first failure — no row strands the batch
  });

  it("a position whose runtime isn't booted is skipped (TOCTOU) — left for the next pass, never lost", async () => {
    const { deps, assessFee } = bdepsOf({
      closed: [{ userId: 'GONE', ourPosition: 'P' }],
      runtimeFor: () => undefined,
    });
    await runClosedFeeBackstop(deps);
    expect(assessFee).not.toHaveBeenCalled();
  });
});
