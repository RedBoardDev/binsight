import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import type { Logger } from 'pino';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigStore } from '@/copybot/config-store';
import { SYSTEM_USER_ID } from '@/copybot/journal-store';
import {
  CONFIG_DEFAULTS,
  type CopybotConfig,
  DEFAULT_LEADER_ADDRESS,
} from '@/domain/copybot/config';
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
// A leader the user has ALREADY started (used to prove create() preserves an existing armed config — #159).
const EXISTING_ARMED_LEADER = 'AnotherLeaderPubkey222222222222222222222222';

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

  it('fresh non-SYSTEM user: the FIRST write is fully INERT — user disabled, ZERO enabled leaders (operator default STOPPED), the added leader present-but-stopped (finding #159)', async () => {
    // WHY (#159 — HIGH multi-user safety): a first-run user's create() must base its FIRST persisted config on the
    // STOPPED seed, NOT on load()'s armed CONFIG_DEFAULTS. Persisting the armed defaults would fan out as
    // `user.enabled && default-leader.enabled` → the fresh user's runtime would spawn and open REAL positions on the
    // OPERATOR's default leader they never chose (the instant signing is enabled). This test fails if create() ever
    // reverts to load()-defaults for a brand-new row.
    const res = await svc.create(USER, input(NEW_LEADER), OWN);
    expect(res).toEqual({ ok: true });
    const cfg = await configStore.load(USER);
    expect(cfg.user.enabled).toBe(false); // master switch OFF — the user has not armed
    expect(cfg.leaders.some((l) => l.enabled)).toBe(false); // ZERO started leaders
    expect(cfg.user.caps.killSwitchGlobal).toBe(false); // the not-yet-armed state, NOT the corrupt-blob emergency halt
    // The operator's default leader is present but STOPPED — it is never auto-followed.
    expect(cfg.leaders.find((l) => l.address === DEFAULT_LEADER_ADDRESS)?.enabled).toBe(false);
    // The user's own added leader is present but STOPPED (they press Start later).
    const added = cfg.leaders.find((l) => l.address === NEW_LEADER);
    expect(added).toBeDefined();
    expect(added?.enabled).toBe(false);
    // A freshly-onboarded user is therefore never on the multi-user brain boot start-list.
    expect(await configStore.listActiveUserIds()).not.toContain(USER);
  });

  it('existing armed user: create() APPENDS the new leader without resetting their armed state (an existing row is read unchanged)', async () => {
    // WHY: the #159 fix must ONLY change the first-run seed. A user who has already armed (enabled:true with a
    // started leader) must keep that state when they add a second leader — seedIfAbsent returns the STORED row for an
    // existing config, so create() never re-seeds over a user's armed config.
    const armed: CopybotConfig = {
      user: { ...CONFIG_DEFAULTS.user, enabled: true },
      leaders: [
        { address: EXISTING_ARMED_LEADER, enabled: true, maxTotalExposureSol: null, overrides: {} },
      ],
    };
    await configStore.save(USER, armed);
    const res = await svc.create(USER, input(NEW_LEADER), OWN);
    expect(res).toEqual({ ok: true });
    const cfg = await configStore.load(USER);
    expect(cfg.user.enabled).toBe(true); // armed master switch PRESERVED — not reset by the fix
    expect(cfg.leaders.find((l) => l.address === EXISTING_ARMED_LEADER)?.enabled).toBe(true); // their started leader stays started
    expect(cfg.leaders.find((l) => l.address === NEW_LEADER)?.enabled).toBe(false); // the newly added leader is STOPPED
  });

  it('SYSTEM: create() still bases on the ARMED defaults — the bench/owner keeps auto-following the default leader', async () => {
    // WHY: the fix splits by tenant via seedConfigFor. SYSTEM (the mono-user bench/owner) must remain armed so its
    // always-on runtime keeps opening on the env-fixed default leader — only non-SYSTEM tenants are seeded STOPPED.
    const res = await svc.create(SYSTEM_USER_ID, input(NEW_LEADER), OWN);
    expect(res).toEqual({ ok: true });
    const cfg = await configStore.load(SYSTEM_USER_ID);
    expect(cfg.user.enabled).toBe(true); // SYSTEM stays armed
    expect(cfg.leaders.find((l) => l.address === DEFAULT_LEADER_ADDRESS)?.enabled).toBe(true); // default leader stays STARTED
    expect(cfg.leaders.find((l) => l.address === NEW_LEADER)?.enabled).toBe(false); // added leader still STOPPED
  });
});
