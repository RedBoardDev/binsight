/**
 * Copy-bot · observability — `EventStore` persistence (integration; requires local Postgres :5435, like
 * journal-store.test.ts). These tests encode the WHY:
 *  - a persisted row back-fills BOTH the legacy columns AND the new tenant/correlation/observability columns
 *    (SPEC §5) — the whole point of P1 is that every row is now attributable by `WHERE wallet=$1`;
 *  - `persist` NEVER throws on a DB failure and logs loud (the cardinal fail-safe contract);
 *  - the serialized `cause` is folded into `detail.cause` (admin-only, JSON-safe).
 */
import { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import type { Logger } from 'pino';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { CopyEvent } from '@/domain/copybot/observability/event';
import { openDatabase } from '@/infrastructure/persistence/database';
import * as schema from '@/infrastructure/persistence/schema';
import { copyJournal } from '@/infrastructure/persistence/schema';
import { EventStore } from './event-store';

const URL = process.env.DATABASE_URL ?? 'postgres://meteora:meteora@localhost:5435/meteora';
const MARKER = '__test_event_store__';
const db = openDatabase(URL);
const noopLog = { warn: vi.fn(), info: vi.fn(), error: vi.fn() } as unknown as Logger;
const clean = (): Promise<unknown> =>
  db.delete(copyJournal).where(eq(copyJournal.eventKey, MARKER));

function event(overrides: Partial<CopyEvent> = {}): CopyEvent {
  const ts = Date.now();
  return {
    code: 'lifecycle.open_confirmed',
    severity: 'info',
    category: 'LIFECYCLE',
    audience: 'feed',
    pinned: false,
    ts,
    eventTs: ts,
    ctx: { userId: 'system', wallet: 'WALLETabc', process: 'brain' },
    correlationId: 'CORR1',
    commandId: 'CORR1',
    eventKey: MARKER,
    stage: 'open',
    outcome: 'confirmed',
    ...overrides,
  };
}

beforeAll(async () => {
  await clean();
});
afterAll(async () => {
  await clean();
});

describe('EventStore — persistence back-fills the new columns (SPEC §5)', () => {
  it('writes both legacy and observability columns from a CopyEvent', async () => {
    await new EventStore(db, noopLog).persistDurable(
      event({ leader: 'LEADER', reason: undefined, adminDetail: { foo: 1 } }),
    );
    const row = (await db.select().from(copyJournal).where(eq(copyJournal.commandId, 'CORR1')))[0]!;
    // legacy columns
    expect(row.process).toBe('brain');
    expect(row.stage).toBe('open');
    expect(row.outcome).toBe('confirmed');
    expect(row.severity).toBe('info');
    expect(row.leader).toBe('LEADER');
    expect(row.detail).toEqual({ foo: 1 });
    // new observability columns
    expect(row.userId).toBe('system');
    expect(row.wallet).toBe('WALLETabc'); // THE filter key
    expect(row.correlationId).toBe('CORR1');
    expect(row.code).toBe('lifecycle.open_confirmed');
    expect(row.category).toBe('LIFECYCLE');
    expect(row.audience).toBe('feed');
    expect(row.pinned).toBe(false);
    expect(row.deliveredAt).toBeNull(); // future external-push outbox state, unused while feed-only
    expect(Number(row.eventTs)).toBeGreaterThan(0);
  });

  it('folds the serialized cause into detail.cause (admin-only, JSON-safe)', async () => {
    await new EventStore(db, noopLog).persistDurable(
      event({ commandId: 'CORR2', correlationId: 'CORR2', cause: { name: 'Error', message: 'x' } }),
    );
    const row = (await db.select().from(copyJournal).where(eq(copyJournal.commandId, 'CORR2')))[0]!;
    expect(row.detail).toEqual({ cause: { name: 'Error', message: 'x' } });
  });
});

describe('EventStore — NEVER throws (the cardinal guarantee)', () => {
  it('swallows a DB write failure and logs loud (the loop guard)', async () => {
    // Model the real drizzle chain insert().values().onConflictDoNothing() — the final step is the awaited promise.
    const brokenDb = {
      insert: () => ({
        values: () => ({
          onConflictDoNothing: async () => {
            throw new Error('db down');
          },
        }),
      }),
    } as unknown as ReturnType<typeof openDatabase>;
    const warn = vi.fn();
    const log = { warn, info: vi.fn(), error: vi.fn() } as unknown as Logger;
    // persist() is fire-and-forget; persistDurable() is awaited — both must resolve without throwing.
    await expect(
      new EventStore(brokenDb, log).persistDurable(
        event({ commandId: 'CORR3', correlationId: 'CORR3' }),
      ),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![1]).toContain('journal write failed');
  });
});

// Fresh in-memory Postgres (PGlite) with the real migrations applied — exercises the durable-dedup unique index
// `uq_copy_journal_wallet_corr_code` exactly as production creates it, with no dependency on a local :5435 server.
const pgliteDb = await (async () => {
  const d = drizzle(new PGlite(), { schema });
  await migrate(d, { migrationsFolder: './drizzle' });
  return d as unknown as ReturnType<typeof openDatabase>;
})();

describe('EventStore — durable dedup is SILENT, not journal_write_failed (#64)', () => {
  it('collapses a true duplicate (same wallet, correlationId, code) to ONE row with NO error log', async () => {
    const warn = vi.fn();
    const log = { warn, info: vi.fn(), error: vi.fn() } as unknown as Logger;
    const store = new EventStore(pgliteDb, log);
    const dup = event({
      ctx: { userId: 'system', wallet: 'W_DUP', process: 'brain' },
      correlationId: 'DUP',
    });

    await store.persistDurable(dup);
    await store.persistDurable(dup); // WS + cursor-poll re-observation after a restart (LRU reset)

    const rows = await pgliteDb.select().from(copyJournal).where(eq(copyJournal.wallet, 'W_DUP'));
    expect(rows).toHaveLength(1); // the unique index collapsed the duplicate
    // The intended dedup MUST NOT masquerade as a DB failure — that error is reserved for real DB errors.
    expect(warn).not.toHaveBeenCalled();
  });

  it('keeps rows with a DISTINCT correlationId as separate rows (so a producer-side attempt discriminator preserves retry audit)', async () => {
    const warn = vi.fn();
    const log = { warn, info: vi.fn(), error: vi.fn() } as unknown as Logger;
    const store = new EventStore(pgliteDb, log);
    const base = {
      ctx: { userId: 'system', wallet: 'W_RETRY', process: 'brain' as const },
      commandId: 'CMD',
    };

    // Two sign-failure attempts on the SAME commandId — a genuine retry becomes a DISTINCT row IFF the producer
    // discriminates the correlationId per attempt (here 'CMD#1' vs 'CMD#2'). The index only collapses TRUE duplicates.
    await store.persistDurable(
      event({ ...base, correlationId: 'CMD#1', code: 'lifecycle.open_failed' }),
    );
    await store.persistDurable(
      event({ ...base, correlationId: 'CMD#2', code: 'lifecycle.open_failed' }),
    );

    const rows = await pgliteDb.select().from(copyJournal).where(eq(copyJournal.wallet, 'W_RETRY'));
    expect(rows).toHaveLength(2); // both retry-audit rows preserved
    expect(warn).not.toHaveBeenCalled();
  });
});
