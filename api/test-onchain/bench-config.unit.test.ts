import { describe, expect, it } from 'vitest';
import { CopybotConfigSchema } from '@/domain/copybot/config';
import { BENCH_DUST_TOKEN_RAW, BENCH_MIN_POSITION_SOL, BENCH_TRADE_RATIO_PCT, buildBenchConfig } from './bench-config';
import { LEADER_TEST } from './env';

// The bench used to drive these values through COPYBOT_* env (the removed override bridge). This test locks the WHY:
// buildBenchConfig must reproduce the EXACT effective config the bench relied on, so migrating to a DB-seeded config
// keeps the on-chain suite's behavior identical (two-sided on, half copy-ratio, 0.02 floor, infinite-add, 1e6 dust).
describe('bench-config · buildBenchConfig (DB-seeded bench config, replaces the env bridge)', () => {
  it('sets the bench tunables the env bridge used to set', () => {
    const { user } = buildBenchConfig();
    expect(user.twoSidedMode).toBe('on'); // was COPYBOT_TWO_SIDED
    expect(user.infiniteAdd).toBe(true); // was COPYBOT_INFINITE_ADD (follow the leader's grows)
    expect(user.sizing.tradeRatioPct).toBe(BENCH_TRADE_RATIO_PCT); // was COPYBOT_TRADE_RATIO_PCT (50)
    expect(user.sizing.minPositionSizeSol).toBe(BENCH_MIN_POSITION_SOL); // was COPYBOT_MIN_POSITION_SOL (0.02)
    expect(user.execution.dustTokenRaw).toBe(BENCH_DUST_TOKEN_RAW); // was DUST_TOKEN_RAW (1e6)
  });

  it('follows the test leader (LEADER_TEST), enabled, no per-leader overrides', () => {
    const cfg = buildBenchConfig();
    expect(cfg.leaders).toEqual([
      { address: LEADER_TEST.toBase58(), enabled: true, maxTotalExposureSol: null, overrides: {} },
    ]);
  });

  it('validates against CopybotConfigSchema (the same guard ConfigStore.save enforces)', () => {
    expect(() => CopybotConfigSchema.parse(buildBenchConfig())).not.toThrow();
    expect(() => CopybotConfigSchema.parse(buildBenchConfig({ killSwitchGlobal: true, maxOpenPositions: 1 }))).not.toThrow();
  });

  it('overlays only the caps patch, leaving the bench tunables intact (the per-test config swap path)', () => {
    const { user } = buildBenchConfig({ killSwitchGlobal: true, maxOpenPositions: 1 });
    expect(user.caps.killSwitchGlobal).toBe(true); // was restartBrainWithEnv({ COPYBOT_KILL_SWITCH: 'true' })
    expect(user.caps.maxOpenPositions).toBe(1); // was restartBrainWithEnv({ COPYBOT_MAX_OPEN_POSITIONS: '1' })
    expect(user.twoSidedMode).toBe('on'); // bench tunables untouched by the patch
    expect(user.sizing.tradeRatioPct).toBe(BENCH_TRADE_RATIO_PCT);
  });

  it('defaults to no caps patch (base bench = kill-switch OFF, spec-default maxOpenPositions)', () => {
    const { user } = buildBenchConfig();
    expect(user.caps.killSwitchGlobal).toBe(false);
    expect(user.caps.killSwitchLeader).toBe(false);
  });

  it('disables the opens-per-window rate cap (3b step 8 made the ring LIVE; the soak bursts past the default)', () => {
    // WHY: the lifecycle bench must stay behaviorally identical across 3b — with the product default (10/10min)
    // now enforced, a soak batch would trip the rate cap mid-run and fail for a non-lifecycle reason. The cap
    // itself is locked by unit tests; a bench test that wants it patches it back in via capsPatch.
    expect(buildBenchConfig().user.caps.maxOpensPerWindow).toBeNull();
    expect(buildBenchConfig({ maxOpensPerWindow: 3 }).user.caps.maxOpensPerWindow).toBe(3); // patch still wins
  });
});
