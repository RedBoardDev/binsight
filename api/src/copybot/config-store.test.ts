import { inArray } from 'drizzle-orm';
import type { Logger } from 'pino';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SYSTEM_USER_ID } from '@/copybot/journal-store';
import {
  CONFIG_DEFAULTS,
  type CopybotConfig,
  InvalidConfigWriteError,
  MAX_STARTED_LEADERS,
  STOPPED_CONFIG_DEFAULTS,
  STOPPED_SEED_CONFIG,
} from '@/domain/copybot/config';
import { openDatabase } from '@/infrastructure/persistence/database';
import { copybotConfigs } from '@/infrastructure/persistence/schema';
import { ConfigStore, seedConfigFor } from './config-store';

// Integration: requires local Postgres (:5435).
const URL = process.env.DATABASE_URL ?? 'postgres://meteora:meteora@localhost:5435/meteora';
const db = openDatabase(URL);
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
// Test-scoped user ids (never the real SYSTEM row) so the suite can't clobber a live dev config.
const U1 = 'test-user-1';
const U2 = 'test-user-2';
const U3 = 'test-user-3';
const TEST_USERS = [U1, U2, U3];
const clean = (): Promise<unknown> =>
  db.delete(copybotConfigs).where(inArray(copybotConfigs.userId, TEST_USERS));

const upsertRaw = async (userId: string, config: string): Promise<void> => {
  await db
    .insert(copybotConfigs)
    .values({ userId, config, updatedAt: Date.now() })
    .onConflictDoUpdate({ target: copybotConfigs.userId, set: { config } });
};

const leader = (address: string, enabled: boolean): CopybotConfig['leaders'][number] => ({
  address,
  enabled,
  maxTotalExposureSol: null,
  overrides: {},
});

beforeEach(async () => {
  await clean();
});
afterAll(async () => {
  await clean();
});

// Pure (no DB): the seed-selection split. Kept DB-free so BOTH branches are covered without seeding the real SYSTEM
// row (the integration suite deliberately never touches 'system' — it would clobber the live dev config).
describe('seedConfigFor — SYSTEM auto-arms, every other tenant seeds STOPPED (idx24)', () => {
  it('SYSTEM seeds the ARMED CONFIG_DEFAULTS so the bench/owner runtime auto-follows the default leader on boot', () => {
    // WHY: the mono-user SYSTEM/bench runtime must keep opening on the env-fixed default leader at boot — unchanged.
    expect(seedConfigFor(SYSTEM_USER_ID)).toBe(CONFIG_DEFAULTS);
    expect(seedConfigFor(SYSTEM_USER_ID).user.enabled).toBe(true);
    expect(seedConfigFor(SYSTEM_USER_ID).leaders.some((l) => l.enabled)).toBe(true); // a STARTED default leader
  });

  it('any NON-SYSTEM tenant seeds STOPPED_SEED_CONFIG — never auto-armed onto a leader it never chose', () => {
    // WHY (idx24): seeding the armed defaults to a real user would silently open REAL positions on the default leader
    // at first boot. A fresh tenant must be inert: master OFF, no started leader, kill switch at its normal OFF.
    const seed = seedConfigFor('a-real-privy-user');
    expect(seed).toBe(STOPPED_SEED_CONFIG);
    expect(seed.user.enabled).toBe(false); // master switch OFF
    expect(seed.leaders.every((l) => !l.enabled)).toBe(true); // no STARTED leader (validateConfigWrite counts enabled)
    expect(seed.user.caps.killSwitchGlobal).toBe(false); // not the emergency-halt state — the user just hasn't armed
  });
});

describe('ConfigStore (integration, per-user rows)', () => {
  it('seedIfAbsent seeds a NON-SYSTEM user STOPPED (idx24) and never overwrites its existing config', async () => {
    // WHY (idx24): a brand-new multi-user tenant must NOT be auto-armed onto the default leader. The seed persists
    // enabled:false + a STOPPED leader, so the freshly-seeded user is not on the boot start-list — the user arms it.
    const store = new ConfigStore(db, log);
    expect(await store.seedIfAbsent(U1)).toEqual(STOPPED_SEED_CONFIG);
    const seeded = await store.load(U1);
    expect(seeded.user.enabled).toBe(false); // master switch OFF — no runtime opens for a never-armed user
    expect(seeded.leaders.every((l) => !l.enabled)).toBe(true); // no STARTED leader
    expect(seeded.user.caps.killSwitchGlobal).toBe(false); // NOT the corrupt-blob emergency halt — just not armed yet
    const active = (await store.listActiveUserIds()).filter((u) => TEST_USERS.includes(u));
    expect(active).not.toContain(U1); // a freshly-seeded user is never on the multi-user boot start-list

    // Idempotent: once a row exists, seedIfAbsent returns the STORED config and never re-seeds over a user edit.
    const custom: CopybotConfig = {
      ...CONFIG_DEFAULTS,
      user: { ...CONFIG_DEFAULTS.user, twoSidedMode: 'on' },
    };
    await store.save(U1, custom);
    expect(await store.seedIfAbsent(U1)).toEqual(custom);
  });

  it('save → load round-trips the exact two-tier config, isolated per user', async () => {
    // WHY (SPEC §12): one row per user — user A's edit must never bleed into user B's runtime.
    const store = new ConfigStore(db, log);
    const customA: CopybotConfig = {
      user: {
        ...CONFIG_DEFAULTS.user,
        caps: { ...CONFIG_DEFAULTS.user.caps, maxOpenPositions: 2 },
        twoSidedMode: 'shadow',
      },
      leaders: [
        {
          address: 'AnotherLeaderPubkey222222222222222222222222',
          enabled: false,
          maxTotalExposureSol: 1.5,
          overrides: { sizing: { tradeRatioPct: 10 } },
        },
      ],
    };
    await store.save(U1, customA);
    await store.save(U2, CONFIG_DEFAULTS);
    expect(await store.load(U1)).toEqual(customA);
    expect(await store.load(U2)).toEqual(CONFIG_DEFAULTS);
  });

  it('load with no row → defaults (fail-safe, no throw)', async () => {
    const store = new ConfigStore(db, log);
    expect(await store.load(U1)).toEqual(CONFIG_DEFAULTS);
  });

  it('save throws on an invalid config (the web caller must never persist junk)', async () => {
    const store = new ConfigStore(db, log);
    const bad = {
      ...CONFIG_DEFAULTS,
      user: {
        ...CONFIG_DEFAULTS.user,
        sizing: { ...CONFIG_DEFAULTS.user.sizing, maxTradeSizeSol: -1 },
      },
    } as unknown as CopybotConfig;
    await expect(store.save(U1, bad)).rejects.toThrow();
  });

  it(`save rejects more than ${MAX_STARTED_LEADERS} STARTED leaders with the typed write error (SPEC §4.3)`, async () => {
    // WHY: the store is the last write gate shared by web + CLI — without it a caller skipping the pure
    // validation could arm a 5th leader.
    const store = new ConfigStore(db, log);
    const tooMany: CopybotConfig = {
      user: CONFIG_DEFAULTS.user,
      leaders: Array.from({ length: MAX_STARTED_LEADERS + 1 }, (_, i) =>
        leader(`Leader${i}1111111111111111111111111111111111111`, true),
      ),
    };
    await expect(store.save(U1, tooMany)).rejects.toThrow(InvalidConfigWriteError);
    // Unlimited configured-but-stopped leaders still save fine.
    const manyStopped: CopybotConfig = {
      user: CONFIG_DEFAULTS.user,
      leaders: Array.from({ length: 10 }, (_, i) =>
        leader(`Leader${i}1111111111111111111111111111111111111`, i < MAX_STARTED_LEADERS),
      ),
    };
    await store.save(U1, manyStopped);
    expect(await store.load(U1)).toEqual(manyStopped);
  });

  it('load on a corrupt blob (no last-good yet) → STOPPED defaults (fail-CLOSED), NOT permissive defaults', async () => {
    const errLog = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
    await upsertRaw(U1, '{not valid json');
    const store = new ConfigStore(db, errLog);
    const cfg = await store.load(U1);
    // Fail-closed: corruption must never revert to the trading-enabled defaults (would fail OPEN).
    expect(cfg.user.enabled).toBe(false);
    expect(cfg.user.caps.killSwitchGlobal).toBe(true);
    expect(cfg).toEqual(STOPPED_CONFIG_DEFAULTS);
    // Proves the fix vs the OLD behavior (old: corrupt → CONFIG_DEFAULTS with enabled:true/killSwitchGlobal:false).
    expect(CONFIG_DEFAULTS.user.caps.killSwitchGlobal).toBe(false);
    expect(errLog.error).toHaveBeenCalledTimes(1);
  });

  it('load caches the last-good config, then a corrupt blob → last-good preserved with the kill switch forced ON', async () => {
    const errLog = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
    const store = new ConfigStore(db, errLog);
    // 1) a valid custom config loads cleanly and is cached as last-good (kill switch OFF, custom fields set).
    const custom: CopybotConfig = {
      user: {
        ...CONFIG_DEFAULTS.user,
        twoSidedMode: 'shadow',
        caps: { ...CONFIG_DEFAULTS.user.caps, killSwitchGlobal: false, maxOpenPositions: 7 },
      },
      leaders: [leader('AnotherLeaderPubkey222222222222222222222222', true)],
    };
    await store.save(U1, custom);
    expect(await store.load(U1)).toEqual(custom);
    // 2) the blob then becomes corrupt → fail closed to last-good with ONLY the kill switch flipped ON.
    await upsertRaw(U1, '{corrupt');
    const cfg = await store.load(U1);
    expect(cfg).toEqual({
      ...custom,
      user: { ...custom.user, caps: { ...custom.user.caps, killSwitchGlobal: true } },
    });
    expect(errLog.error).toHaveBeenCalledTimes(1);
  });

  it('a corrupt blob can NEVER load as enabled with the kill switch off — with OR without a last-good', async () => {
    // WHY (SPEC §12): the whole point of fail-closed — whatever the store held before, a corrupt row must leave
    // the bot HALTED (killSwitchGlobal true blocks every open in checkCaps) until an operator repairs it.
    const errLog = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
    const store = new ConfigStore(db, errLog);
    // Without last-good:
    await upsertRaw(U1, 'garbage');
    const noLastGood = await store.load(U1);
    expect(noLastGood.user.enabled).toBe(false);
    expect(noLastGood.user.caps.killSwitchGlobal).toBe(true);
    // With last-good (an ENABLED config):
    await store.save(U2, CONFIG_DEFAULTS); // enabled:true, killSwitchGlobal:false
    await store.load(U2);
    await upsertRaw(U2, 'garbage');
    const withLastGood = await store.load(U2);
    expect(withLastGood.user.caps.killSwitchGlobal).toBe(true); // opens blocked whatever `enabled` says
    expect(errLog.error).toHaveBeenCalledTimes(2);
  });

  it('the per-user last-good cache never crosses users (A last-good cannot mask B corruption)', async () => {
    const errLog = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
    const store = new ConfigStore(db, errLog);
    await store.save(U1, CONFIG_DEFAULTS);
    await store.load(U1); // U1 last-good cached
    await upsertRaw(U2, 'garbage'); // U2 corrupt, NO U2 last-good
    const cfg = await store.load(U2);
    expect(cfg).toEqual(STOPPED_CONFIG_DEFAULTS); // stopped defaults — not U1's permissive last-good
  });

  it('listActiveUserIds returns ONLY users whose config is enabled; a corrupt row is never active', async () => {
    // WHY: this is the multi-user boot list (increment 3) — a corrupt config booting a runtime, or a disabled
    // user being started, would both violate the start/stop model.
    const store = new ConfigStore(db, log);
    await store.save(U1, CONFIG_DEFAULTS); // enabled:true
    await store.save(U2, {
      ...CONFIG_DEFAULTS,
      user: { ...CONFIG_DEFAULTS.user, enabled: false },
    });
    await upsertRaw(U3, '{corrupt'); // corrupt ⇒ parses fail-closed to enabled:false
    const active = (await store.listActiveUserIds()).filter((u) => TEST_USERS.includes(u));
    expect(active).toEqual([U1]);
  });

  it('allUserIds returns EVERY configured user — enabled, disabled, OR corrupt (the GLOBAL KILL target)', async () => {
    // WHY (SPEC §10/§13): the operator halt must reach every tenant. Unlike listActiveUserIds, allUserIds must NOT
    // filter on `enabled` — a stopped or corrupt row still owns caps the kill switch has to force ON.
    const store = new ConfigStore(db, log);
    await store.save(U1, CONFIG_DEFAULTS); // enabled
    await store.save(U2, {
      ...CONFIG_DEFAULTS,
      user: { ...CONFIG_DEFAULTS.user, enabled: false },
    }); // disabled
    await upsertRaw(U3, '{corrupt'); // corrupt
    const all = (await store.allUserIds()).filter((u) => TEST_USERS.includes(u)).sort();
    expect(all).toEqual([U1, U2, U3]);
  });
});
