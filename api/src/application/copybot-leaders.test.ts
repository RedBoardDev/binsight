import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import type { Logger } from 'pino';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigStore } from '@/copybot/config-store';
import { DEFAULT_LEADER_ADDRESS } from '@/domain/copybot/config';
import type { NewLeaderInput } from '@/domain/copybot/leader-onboard';
import type { Database } from '@/infrastructure/persistence/database';
import * as schema from '@/infrastructure/persistence/schema';
import { copybotConfigs } from '@/infrastructure/persistence/schema';
import { CopybotLeadersService } from './copybot-leaders';

const db = await (async () => {
  const d = drizzle(new PGlite(), { schema });
  await migrate(d, { migrationsFolder: './drizzle' });
  return d as unknown as Database;
})();

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
const configStore = new ConfigStore(db, log);
const USER = 'user-leaders-1';
const OWN = 'Ybbt2Td4TjxwpzvuicbP9ANizBwAJzqjuRmRrvDh9zz';
const NEW_LEADER = '5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1';

let hasActivity = true;
const svc = new CopybotLeadersService({
  configStore,
  hasDlmmActivity: async () => hasActivity,
  log,
});

const input = (address: string): NewLeaderInput => ({
  address,
  maxTradeSizeSol: 1,
  tradeRatioPct: 100,
  maxTotalExposureSol: null,
  twoSidedMode: 'off',
});

beforeEach(async () => {
  await db.delete(copybotConfigs);
  hasActivity = true;
  vi.clearAllMocks();
});

describe('CopybotLeadersService.validate', () => {
  it('accepts a valid, new address with DLMM activity', async () => {
    expect(await svc.validate(USER, NEW_LEADER, OWN)).toEqual({ ok: true });
  });

  it('rejects the default (already-configured) leader as a duplicate', async () => {
    // A fresh user loads CONFIG_DEFAULTS which already follows the default leader.
    expect(await svc.validate(USER, DEFAULT_LEADER_ADDRESS, OWN)).toEqual({
      ok: false,
      reason: 'duplicate',
    });
  });

  it('rejects the user own bot wallet', async () => {
    expect(await svc.validate(USER, OWN, OWN)).toEqual({ ok: false, reason: 'own_wallet' });
  });

  it('rejects a malformed address', async () => {
    expect(await svc.validate(USER, 'nope!', OWN)).toEqual({
      ok: false,
      reason: 'invalid_address',
    });
  });

  it('rejects a wallet with no DLMM activity (checked only after the deterministic gates pass)', async () => {
    hasActivity = false;
    expect(await svc.validate(USER, NEW_LEADER, OWN)).toEqual({
      ok: false,
      reason: 'no_dlmm_activity',
    });
  });
});

describe('CopybotLeadersService.create', () => {
  it('adds the leader STOPPED and persists it', async () => {
    const res = await svc.create(USER, input(NEW_LEADER), OWN);
    expect(res).toEqual({ ok: true });
    const cfg = await configStore.load(USER);
    const added = cfg.leaders.find((l) => l.address === NEW_LEADER);
    expect(added?.enabled).toBe(false);
  });

  it('re-runs the deterministic guard on write — a duplicate is rejected (a race between validate and submit)', async () => {
    await svc.create(USER, input(NEW_LEADER), OWN);
    const res = await svc.create(USER, input(NEW_LEADER), OWN);
    expect(res).toEqual({ ok: false, reason: 'duplicate' });
  });

  it('rejects the own bot wallet on write', async () => {
    expect(await svc.create(USER, input(OWN), OWN)).toEqual({ ok: false, reason: 'own_wallet' });
  });
});
