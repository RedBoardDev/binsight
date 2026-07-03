/**
 * Copy-bot · Inc.4d — fee-sweep invariants (SPEC §9). These encode the WHY:
 *  - a pending fee is published to the OWNING user's runtime with the exact lamports (the sweep must not sign nor
 *    move funds itself — it delegates to the tenant that owns the wallet);
 *  - every publish attempt is COUNTED before the publish, so a failing publish still records the try and the row
 *    stays retryable (a fee is retried each sweep until it lands, never dropped);
 *  - a publish failure is swallowed — a fee failure must NEVER throw out of the sweep (it must never block a close);
 *  - a fee whose user runtime is not booted is skipped (left pending, retried later) — never lost, never mis-signed.
 */
import { pino } from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { type FeeSweepDeps, runFeeSweep, type SweepableFee } from './fee-sweep';

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
});
