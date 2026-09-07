import { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import type { Logger } from 'pino';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigStore } from '@/copybot/config-store';
import { CONFIG_DEFAULTS } from '@/domain/copybot/config';
import { HEARTBEAT_STALE_MS } from '@/domain/copybot/status';
import type { Database } from '@/infrastructure/persistence/database';
import * as schema from '@/infrastructure/persistence/schema';
import { copybotConfigs, copybotStatus, copyJournal } from '@/infrastructure/persistence/schema';
import { CopybotAdminService, QUARANTINE_ALERT_CODES, QUARANTINE_LIMIT_MAX } from './copybot-admin';

// Fresh in-memory Postgres (PGlite) with the real Drizzle migrations — the admin service runs the exact SQL it
// runs in production (real ConfigStore, real copy_journal/copybot_status shapes), no network, no external DB.
const db = await (async () => {
  const d = drizzle(new PGlite(), { schema });
  await migrate(d, { migrationsFolder: './drizzle' });
  return d as unknown as Database;
})();

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
const U1 = 'admin-test-user-1';
const U2 = 'admin-test-user-2';
const U3 = 'admin-test-user-3';

/** A minimal well-formed copy_journal row (the NOT NULL columns) with an overridable code + ts. */
const journalRow = (code: string, ts: number) => ({
  ts,
  process: 'coffre' as const,
  stage: 'sign',
  outcome: 'rejected',
  severity: 'error',
  code,
  wallet: 'WALLET_A',
});

beforeEach(async () => {
  await db.delete(copybotConfigs);
  await db.delete(copybotStatus);
  await db.delete(copyJournal);
  vi.clearAllMocks();
});

describe('QUARANTINE_ALERT_CODES', () => {
  it('is exactly the pinned SYSTEM codes — includes command_quarantined, excludes non-pinned + non-SYSTEM', () => {
    // WHY: the operator "quarantine / alerts" panel must surface process-level alerts (a dead-lettered forged
    // command, a fatal stop, a blind detector) and NOT per-position activity — a mis-scoped filter would either
    // bury the quarantine signal in lifecycle noise or drop it entirely.
    expect(QUARANTINE_ALERT_CODES).toContain('system.command_quarantined');
    expect(QUARANTINE_ALERT_CODES).toContain('system.fatal');
    expect(QUARANTINE_ALERT_CODES).toContain('system.detection_stale');
    expect(QUARANTINE_ALERT_CODES).not.toContain('system.ws_error'); // SYSTEM but not pinned
    expect(QUARANTINE_ALERT_CODES).not.toContain('failsafe.rug_sl_triggered'); // pinned but not SYSTEM
    expect(QUARANTINE_ALERT_CODES).not.toContain('lifecycle.open_confirmed'); // feed but not pinned
  });
});

describe('CopybotAdminService.killGlobal', () => {
  it('forces killSwitchGlobal ON for EVERY user (enabled, disabled, corrupt) and publishes exactly once', async () => {
    // WHY (SPEC §13): the away-from-desk kill must halt every configured tenant, not just the enabled ones — a
    // disabled or corrupt row still owns caps the halt has to force ON. And it fires ONE ping so the halt applies
    // to every runtime in <100ms.
    const store = new ConfigStore(db, log);
    await store.save(U1, CONFIG_DEFAULTS); // enabled, killSwitch off
    await store.save(U2, { ...CONFIG_DEFAULTS, user: { ...CONFIG_DEFAULTS.user, enabled: false } }); // disabled
    // A corrupt blob: it must be reached (counted + halted via fail-closed) but NEVER clobbered back to defaults.
    await db
      .insert(copybotConfigs)
      .values({ userId: U3, config: '{corrupt', updatedAt: Date.now() });

    const publish = vi.fn(async () => {});
    const svc = new CopybotAdminService(db, store, publish, log);
    const res = await svc.killGlobal();

    expect(res).toEqual({ killed: 3 });
    expect(publish).toHaveBeenCalledTimes(1);
    // Every user now loads with the kill switch ON.
    expect((await store.load(U1)).user.caps.killSwitchGlobal).toBe(true);
    expect((await store.load(U2)).user.caps.killSwitchGlobal).toBe(true);
    expect((await store.load(U3)).user.caps.killSwitchGlobal).toBe(true);
    // The corrupt blob was NOT clobbered — it is still the unparseable raw string on disk (load() fail-closes it
    // to kill-ON without persisting, so the operator can later repair the real config).
    const rawU3 = await db
      .select({ config: copybotConfigs.config })
      .from(copybotConfigs)
      .where(eq(copybotConfigs.userId, U3));
    expect(rawU3[0]?.config).toBe('{corrupt');
  });

  it('is idempotent: a second kill still returns the full count and publishes again without throwing', async () => {
    const store = new ConfigStore(db, log);
    await store.save(U1, CONFIG_DEFAULTS);
    const publish = vi.fn(async () => {});
    const svc = new CopybotAdminService(db, store, publish, log);

    expect(await svc.killGlobal()).toEqual({ killed: 1 });
    expect(await svc.killGlobal()).toEqual({ killed: 1 }); // already killed → skipped write, same stable count
    expect(publish).toHaveBeenCalledTimes(2); // one ping per operator action
    expect((await store.load(U1)).user.caps.killSwitchGlobal).toBe(true);
  });

  it('with no configured users → killed:0 and still pings (a no-op halt is not an error)', async () => {
    const store = new ConfigStore(db, log);
    const publish = vi.fn(async () => {});
    const svc = new CopybotAdminService(db, store, publish, log);
    expect(await svc.killGlobal()).toEqual({ killed: 0 });
    expect(publish).toHaveBeenCalledTimes(1);
  });
});

describe('CopybotAdminService.status', () => {
  it('maps each heartbeat row to online/stale + ageMs, and a missing process to null', async () => {
    // WHY: online/offline is DERIVED from heartbeat freshness (a crashed process cannot flip a stored flag), so the
    // service must compute staleness from `ts`, not trust a boolean.
    const now = 1_000_000_000_000;
    const freshTs = now - 5_000; // 5s ago → online
    const staleTs = now - (HEARTBEAT_STALE_MS + 1_000); // beyond the stale window → offline
    await db
      .insert(copybotStatus)
      .values({ process: 'brain', ts: freshTs, detail: { openPositions: 2 } });
    await db
      .insert(copybotStatus)
      .values({ process: 'coffre', ts: staleTs, detail: { signingEnabled: true } });

    const svc = new CopybotAdminService(
      db,
      new ConfigStore(db, log),
      vi.fn(async () => {}),
      log,
    );
    const view = await svc.status(now);

    expect(view.brain).toEqual({
      ts: freshTs,
      ageMs: 5_000,
      online: true,
      detail: { openPositions: 2 },
    });
    expect(view.coffre?.online).toBe(false);
    expect(view.coffre?.ageMs).toBe(HEARTBEAT_STALE_MS + 1_000);
    expect(view.coffre?.detail).toEqual({ signingEnabled: true });
  });

  it('returns null for both processes when no heartbeat exists yet', async () => {
    const svc = new CopybotAdminService(
      db,
      new ConfigStore(db, log),
      vi.fn(async () => {}),
      log,
    );
    expect(await svc.status()).toEqual({ brain: null, coffre: null });
  });
});

describe('CopybotAdminService.quarantine', () => {
  it('returns only the pinned SYSTEM alert codes, newest first, bounded', async () => {
    // WHY: the panel is the operator's alert surface — it must show quarantined/fatal/blind-detector rows (newest
    // first) and never the routine lifecycle feed, and must never run an unbounded scan.
    await db.insert(copyJournal).values([
      journalRow('system.command_quarantined', 100),
      journalRow('system.fatal', 300),
      journalRow('system.ws_error', 400), // SYSTEM but not pinned → excluded
      journalRow('failsafe.rug_sl_triggered', 500), // pinned but not SYSTEM → excluded
      journalRow('lifecycle.open_confirmed', 600), // feed but not pinned → excluded
      journalRow('system.detection_stale', 200),
    ]);

    const svc = new CopybotAdminService(
      db,
      new ConfigStore(db, log),
      vi.fn(async () => {}),
      log,
    );
    const rows = await svc.quarantine();

    expect(rows.map((r) => r.code)).toEqual([
      'system.fatal', // ts 300
      'system.detection_stale', // ts 200
      'system.command_quarantined', // ts 100
    ]);
  });

  it('honours the limit and clamps it to the max', async () => {
    const many = Array.from({ length: 5 }, (_, i) =>
      journalRow('system.command_quarantined', 1_000 + i),
    );
    await db.insert(copyJournal).values(many);
    const svc = new CopybotAdminService(
      db,
      new ConfigStore(db, log),
      vi.fn(async () => {}),
      log,
    );

    expect((await svc.quarantine(2)).length).toBe(2); // bound honoured
    expect((await svc.quarantine(QUARANTINE_LIMIT_MAX + 10_000)).length).toBe(5); // clamped, returns all 5
    expect((await svc.quarantine(0)).length).toBe(5); // 0 → default, not an empty page
  });
});
