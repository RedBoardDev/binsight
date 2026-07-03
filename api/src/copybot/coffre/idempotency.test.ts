import { PGlite } from '@electric-sql/pglite';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { describe, expect, it } from 'vitest';
import type { Database } from '@/infrastructure/persistence/database';
import * as schema from '@/infrastructure/persistence/schema';
import { executions } from '@/infrastructure/persistence/schema';
import { claimExecution } from './idempotency';

// Fresh in-memory Postgres (PGlite) with the real Drizzle migrations applied — the multi-tenant executions
// PK (user_id, command_id) is exercised exactly as production creates it.
const db = await (async () => {
  const d = drizzle(new PGlite(), { schema });
  await migrate(d, { migrationsFolder: './drizzle' });
  return d as unknown as Database;
})();

const USER = 'test-user-1';
const USER_2 = 'test-user-2';
const CID = '__test_idem_cmd__';
const rowOf = async (userId: string, commandId: string) =>
  (
    await db
      .select()
      .from(executions)
      .where(and(eq(executions.userId, userId), eq(executions.commandId, commandId)))
  )[0];
const setState = (userId: string, commandId: string, state: string) =>
  db
    .update(executions)
    .set({ state })
    .where(and(eq(executions.userId, userId), eq(executions.commandId, commandId)));

// These cases run in order on a shared (userId, commandId) — they walk the execution state machine on purpose.
describe('claimExecution — per-user idempotency claim with failed-retry', () => {
  it('fresh command → claimed (true)', async () => {
    expect(await claimExecution(db, USER, CID, 'ek', 999, 1)).toBe(true);
  });

  it('same command already claimed → duplicate (false, no double-sign)', async () => {
    // WHY: the executions row guarantees one command = one signature; a re-delivery must not double-sign.
    expect(await claimExecution(db, USER, CID, 'ek', 999, 2)).toBe(false);
  });

  it('★ the SAME commandId for a DIFFERENT user claims its OWN slot (user #2 is never user #1 duplicate)', async () => {
    // WHY (SPEC §11, ULTRACODE #25/#27): the claim is keyed (user_id, command_id). With a command_id-only PK,
    // user #2's copy of the same leader event would conflict with user #1's already-claimed row and be rejected
    // as 'duplicate' — user #2 silently misses the copy. This test FAILS on the old single-column PK.
    expect(await claimExecution(db, USER_2, CID, 'ek', 999, 3)).toBe(true);
    // …and each user's row lives independently:
    expect((await rowOf(USER, CID))?.state).toBe('claimed');
    expect((await rowOf(USER_2, CID))?.state).toBe('claimed');
  });

  it('a landed command is never re-claimed (false) — and does not leak into the other user', async () => {
    await setState(USER, CID, 'landed');
    expect(await claimExecution(db, USER, CID, 'ek', 999, 4)).toBe(false);
    // user #2's slot (still 'claimed') is untouched by user #1's terminal state:
    expect((await rowOf(USER_2, CID))?.state).toBe('claimed');
  });

  it('a FAILED command CAN be re-claimed → retry (true) and goes back to claimed', async () => {
    // WHY: a failed close must be retryable by the reconcile re-publish; otherwise the position stays dormant.
    await setState(USER, CID, 'failed');
    expect(await claimExecution(db, USER, CID, 'ek', 999, 5)).toBe(true);
    expect((await rowOf(USER, CID))?.state).toBe('claimed');
  });

  it('a stranded CLAIMED command is re-claimable ONLY during vault PENDING-recovery (no normal-flow double-sign)', async () => {
    // The (USER, CID) row is in 'claimed' state here. WHY: a vault that claimed a command then crashed before
    // landing must, on RESTART, re-process its pending (single-consumer → the prior claimant is provably dead).
    // Normal flow must keep rejecting a re-delivered 'claimed' (no double-sign on a still-in-flight command);
    // only recovery re-claims it.
    expect(await claimExecution(db, USER, CID, 'ek', 999, 6)).toBe(false); // normal flow → still a duplicate
    expect(await claimExecution(db, USER, CID, 'ek', 999, 7, true)).toBe(true); // recovering=true → re-claimable
  });

  it('forceReclaim re-claims a stale LANDED close (failsafe/orphan retry) — fixes the stuck-phantom bug', async () => {
    // WHY: a reconcile failsafe/orphan close is emitted ONLY while the position is PROVABLY still on-chain. A prior
    // 'landed' that never actually removed it (stranded/ineffective close) must NOT block the retry — else the
    // phantom position is stuck open forever and the copier wallet never returns to SOL-only. Normal flow still
    // rejects a landed; forceReclaim (set only for kind:'close' with eventKey action failsafe/orphan) re-claims it.
    await setState(USER, CID, 'landed');
    expect(await claimExecution(db, USER, CID, 'ek', 999, 8)).toBe(false); // normal flow → still rejects a landed
    expect(await claimExecution(db, USER, CID, 'ek', 999, 9, false, true)).toBe(true); // forceReclaim → re-claims to retry
    expect((await rowOf(USER, CID))?.state).toBe('claimed');
  });

  it('forceReclaim also re-claims a SKIPPED close', async () => {
    await setState(USER, CID, 'skipped');
    expect(await claimExecution(db, USER, CID, 'ek', 999, 10, false, true)).toBe(true);
  });
});
