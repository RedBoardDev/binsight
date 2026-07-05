import { describe, expect, it } from 'vitest';
import { RUG_SL_RETAIN_MS } from '../rug-sl';
import {
  CONFIG_DEFAULTS,
  type CopybotConfig,
  CopybotConfigSchema,
  DEFAULT_LEADER_ADDRESS,
  effectiveFor,
  isValidConfigBlob,
  parseConfig,
  STOPPED_CONFIG_DEFAULTS,
} from './index';

const LEADER = DEFAULT_LEADER_ADDRESS;

describe('config · defaults + schema', () => {
  it('CONFIG_DEFAULTS is valid and has exactly one default leader', () => {
    expect(CopybotConfigSchema.safeParse(CONFIG_DEFAULTS).success).toBe(true);
    expect(CONFIG_DEFAULTS.leaders).toHaveLength(1);
    expect(CONFIG_DEFAULTS.leaders[0]!.address).toBe(LEADER);
  });

  it('the spec-locked defaults hold (a silent change to a policy default breaks this)', () => {
    // WHY: these are the agreed product defaults (docs/reference/copybot-settings.md). This pins them so a refactor
    // or a careless edit can't drift the fresh-bot policy unnoticed.
    const u = CONFIG_DEFAULTS.user;
    expect(u.sizing.tradeRatioPct).toBe(100); // follow the leader, capped (spec §3)
    expect(u.sizing.maxTradeSizeSol).toBe(1.0);
    expect(u.sizing.minPositionSizeSol).toBe(0.05);
    expect(u.caps.maxOpenPositions).toBe(8);
    expect(u.twoSidedMode).toBe('off'); // token-leg policy = skip
    expect(u.filters).toEqual(expect.objectContaining({ minJupOrganicScore: null })); // filters off by default (for now)
    expect(u.priorityFee).toEqual({ tier: 'medium', maxCapSol: 0.005 }); // spec §5
    expect(u.rugSl).toEqual({ enabled: true, dropPercent: 40, windowSeconds: 60 }); // spec §7
    expect(u.infiniteAdd).toBe(false); // spec §8: only the first deposit by default
    expect(u.claimFloorSol).toBe(0.01); // skip dust fee-claims (≈ Valhalla $2)
    expect(u.jitoEnabled).toBe(false); // Jito bundle landing is opt-in
    expect(u.priorityFeeOracle).toBe(false); // live fee oracle is opt-in (spec §5)
  });
});

describe('config · infiniteAdd', () => {
  it('a leader can override infiniteAdd to true (follow the leader’s adds)', () => {
    const cfg: CopybotConfig = {
      user: CONFIG_DEFAULTS.user,
      leaders: [
        {
          address: LEADER,
          enabled: true,
          maxTotalExposureSol: null,
          overrides: { infiniteAdd: true },
        },
      ],
    };
    expect(effectiveFor(cfg, LEADER).infiniteAdd).toBe(true);
    expect(effectiveFor(CONFIG_DEFAULTS, LEADER).infiniteAdd).toBe(false); // default unaffected
  });
});

describe('config · rugSl', () => {
  it('a leader sparsely overrides the drop threshold, the rest inherit', () => {
    const cfg: CopybotConfig = {
      user: CONFIG_DEFAULTS.user,
      leaders: [
        {
          address: LEADER,
          enabled: true,
          maxTotalExposureSol: null,
          overrides: { rugSl: { dropPercent: 25 } },
        },
      ],
    };
    const r = effectiveFor(cfg, LEADER).rugSl;
    expect(r.dropPercent).toBe(25);
    expect(r.enabled).toBe(true); // sibling preserved
    expect(r.windowSeconds).toBe(60);
  });
});

describe('config · priorityFee', () => {
  it('a leader sparsely overrides the tier, the cap inherits', () => {
    const cfg: CopybotConfig = {
      user: CONFIG_DEFAULTS.user,
      leaders: [
        {
          address: LEADER,
          enabled: true,
          maxTotalExposureSol: null,
          overrides: { priorityFee: { tier: 'high' } },
        },
      ],
    };
    const pf = effectiveFor(cfg, LEADER).priorityFee;
    expect(pf.tier).toBe('high');
    expect(pf.maxCapSol).toBe(CONFIG_DEFAULTS.user.priorityFee.maxCapSol); // sibling preserved
  });
});

describe('config · parseConfig (fail-safe + fail-CLOSED + migration)', () => {
  it('null / empty (genuine first run) → the permissive defaults', () => {
    expect(parseConfig(null)).toEqual(CONFIG_DEFAULTS);
    expect(parseConfig('')).toEqual(CONFIG_DEFAULTS);
  });

  it('non-JSON / non-object → STOPPED defaults (fail CLOSED, SPEC §12), never the permissive defaults', () => {
    // WHY: only a genuinely ABSENT blob may yield the trading-enabled defaults. A blob that EXISTS but is corrupt
    // means a stopped bot could silently re-arm if we fell back to enabled:true/killSwitchGlobal:false.
    expect(parseConfig('}{')).toEqual(STOPPED_CONFIG_DEFAULTS);
    expect(parseConfig('42')).toEqual(STOPPED_CONFIG_DEFAULTS);
    expect(parseConfig('"a string"')).toEqual(STOPPED_CONFIG_DEFAULTS);
  });

  it('a corrupt blob can NEVER yield enabled:true or killSwitchGlobal:false', () => {
    // WHY (SPEC §12): the parse-level fail-closed contract — whatever garbage is stored, the result is a STOPPED
    // config. This is the invariant the adapter (ConfigStore) builds on.
    const corruptBlobs = [
      '}{',
      'null',
      '42',
      '[]',
      JSON.stringify({ user: { sizing: { maxTradeSizeSol: 'huge' } } }),
    ];
    for (const raw of corruptBlobs) {
      const cfg = parseConfig(raw);
      expect(cfg.user.enabled, raw).toBe(false);
      expect(cfg.user.caps.killSwitchGlobal, raw).toBe(true);
    }
  });

  it('a partial user block merges onto defaults — unset fields keep their default (no silent reset)', () => {
    const cfg = parseConfig(JSON.stringify({ user: { caps: { killSwitchGlobal: true } } }));
    expect(cfg.user.caps.killSwitchGlobal).toBe(true);
    expect(cfg.user.caps.maxOpenPositions).toBe(CONFIG_DEFAULTS.user.caps.maxOpenPositions);
    expect(cfg.user.sizing).toEqual(CONFIG_DEFAULTS.user.sizing);
  });

  it('a config persisted BEFORE a flag existed gains its default (priorityFeeOracle/jitoEnabled → false)', () => {
    // WHY: a blob written by an older build has no `priorityFeeOracle` (nor `jitoEnabled`) key — migration must
    // backfill the safe default (off), never crash on the missing field nor flip the feature on by surprise.
    const cfg = parseConfig(JSON.stringify({ user: { sizing: { tradeRatioPct: 30 } } }));
    expect(cfg.user.priorityFeeOracle).toBe(false);
    expect(cfg.user.jitoEnabled).toBe(false);
    expect(cfg.user.sizing.tradeRatioPct).toBe(30); // the provided field still wins
  });

  it('migrates a legacy FLAT blob ({leader, sizing, caps, twoSidedMode}) into the two-tier shape', () => {
    // WHY: an existing dev config must not be lost when we restructure — it's transparently upgraded.
    const legacy = JSON.stringify({
      leader: 'LegacyLeader1111111111111111111111111111111',
      sizing: {
        tradeRatioPct: 25,
        maxTradeSizeSol: 0.5,
        minPositionSizeSol: 0.05,
        solReserveSol: 0.05,
        onInsufficient: 'skip',
      },
      caps: CONFIG_DEFAULTS.user.caps,
      twoSidedMode: 'on',
    });
    const cfg = parseConfig(legacy);
    expect(cfg.user.sizing.tradeRatioPct).toBe(25);
    expect(cfg.user.twoSidedMode).toBe('on');
    expect(cfg.leaders).toHaveLength(1);
    expect(cfg.leaders[0]!.address).toBe('LegacyLeader1111111111111111111111111111111');
    // WHY: the flat blob means the bot was RUNNING that leader — the migration must not silently stop it
    // (stopped-by-default applies to newly-added leaders only, never to a live config upgrade).
    expect(cfg.leaders[0]!.enabled).toBe(true);
  });

  it('a structurally invalid value → STOPPED defaults (fail CLOSED, SPEC §12)', () => {
    expect(parseConfig(JSON.stringify({ user: { sizing: { maxTradeSizeSol: 'huge' } } }))).toEqual(
      STOPPED_CONFIG_DEFAULTS,
    );
  });

  it('a leader persisted WITHOUT an enabled bit merges as STOPPED (never silently started)', () => {
    // WHY (SPEC §4.3): a just-added leader must never start copying before the user presses Start — the merge
    // default is the last line of defense when a writer forgets the flag.
    const cfg = parseConfig(JSON.stringify({ leaders: [{ address: LEADER }] }));
    expect(cfg.leaders[0]!.enabled).toBe(false);
    expect(cfg.leaders[0]!.maxTotalExposureSol).toBeNull(); // new knob backfills to "no per-leader cap"
  });

  it('round-trips a full valid two-tier blob', () => {
    const custom: CopybotConfig = {
      user: { ...CONFIG_DEFAULTS.user, twoSidedMode: 'shadow' },
      leaders: [
        {
          address: LEADER,
          enabled: false,
          maxTotalExposureSol: 0.75,
          overrides: { twoSidedMode: 'on' },
        },
      ],
    };
    expect(parseConfig(JSON.stringify(custom))).toEqual(custom);
  });
});

describe('config · isValidConfigBlob', () => {
  it('true for a valid (even partial) blob, false for null/garbage', () => {
    expect(isValidConfigBlob(JSON.stringify({ user: { caps: { killSwitchGlobal: true } } }))).toBe(
      true,
    );
    expect(isValidConfigBlob(null)).toBe(false);
    expect(isValidConfigBlob('nope')).toBe(false);
    expect(isValidConfigBlob(JSON.stringify({ user: { sizing: { maxTradeSizeSol: 'x' } } }))).toBe(
      false,
    );
  });
});

describe('config · effectiveFor', () => {
  it('with no overrides, returns the user defaults for that leader', () => {
    const eff = effectiveFor(CONFIG_DEFAULTS, LEADER);
    expect(eff.sizing).toEqual(CONFIG_DEFAULTS.user.sizing);
    expect(eff.twoSidedMode).toBe(CONFIG_DEFAULTS.user.twoSidedMode);
    expect(eff.leaderEnabled).toBe(true);
    expect(eff.caps.killSwitchLeader).toBe(false);
  });

  it('leader overrides win over user defaults (twoSided + sizing field)', () => {
    const cfg: CopybotConfig = {
      user: CONFIG_DEFAULTS.user,
      leaders: [
        {
          address: LEADER,
          enabled: true,
          maxTotalExposureSol: null,
          overrides: { twoSidedMode: 'on', sizing: { tradeRatioPct: 10 } },
        },
      ],
    };
    const eff = effectiveFor(cfg, LEADER);
    expect(eff.twoSidedMode).toBe('on');
    expect(eff.sizing.tradeRatioPct).toBe(10);
    expect(eff.sizing.maxTradeSizeSol).toBe(CONFIG_DEFAULTS.user.sizing.maxTradeSizeSol); // sibling preserved
  });

  it('maxTradeSizeSol is LOWER-ONLY — a leader can tighten but never raise the user ceiling', () => {
    // WHY: a per-leader override must never increase risk beyond the account ceiling (a typo or a malicious config).
    const user = {
      ...CONFIG_DEFAULTS.user,
      sizing: { ...CONFIG_DEFAULTS.user.sizing, maxTradeSizeSol: 1.0 },
    };
    const raise: CopybotConfig = {
      user,
      leaders: [
        {
          address: LEADER,
          enabled: true,
          maxTotalExposureSol: null,
          overrides: { sizing: { maxTradeSizeSol: 5 } },
        },
      ],
    };
    const lower: CopybotConfig = {
      user,
      leaders: [
        {
          address: LEADER,
          enabled: true,
          maxTotalExposureSol: null,
          overrides: { sizing: { maxTradeSizeSol: 0.3 } },
        },
      ],
    };
    expect(effectiveFor(raise, LEADER).sizing.maxTradeSizeSol).toBe(1.0); // raise rejected → clamped to ceiling
    expect(effectiveFor(lower, LEADER).sizing.maxTradeSizeSol).toBe(0.3); // tighten honored
  });

  it('a disabled leader resolves to killSwitchLeader=true (so checkCaps blocks its opens)', () => {
    const cfg: CopybotConfig = {
      user: CONFIG_DEFAULTS.user,
      leaders: [{ address: LEADER, enabled: false, maxTotalExposureSol: null, overrides: {} }],
    };
    const eff = effectiveFor(cfg, LEADER);
    expect(eff.leaderEnabled).toBe(false);
    expect(eff.caps.killSwitchLeader).toBe(true);
  });

  it('the user master switch off ⇒ killSwitchGlobal=true (no opens, exits still run)', () => {
    const cfg: CopybotConfig = {
      user: { ...CONFIG_DEFAULTS.user, enabled: false },
      leaders: CONFIG_DEFAULTS.leaders,
    };
    expect(effectiveFor(cfg, LEADER).caps.killSwitchGlobal).toBe(true);
  });

  it('an unknown leader address falls back to user defaults, treated as STOPPED (fail closed)', () => {
    // WHY (SPEC §4.3): a leader REMOVED from the list counts as stopped. If an unconfigured address resolved as
    // enabled, removing a leader (or watching one never added) would keep copying it — the stop model failing OPEN.
    const eff = effectiveFor(CONFIG_DEFAULTS, 'UnknownLeaderXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX');
    expect(eff.leaderEnabled).toBe(false);
    expect(eff.caps.killSwitchLeader).toBe(true); // checkCaps blocks its opens
    expect(eff.sizing).toEqual(CONFIG_DEFAULTS.user.sizing);
  });

  it('resolves the per-leader exposure ceiling (its own leader only; unknown/uncapped ⇒ null)', () => {
    // WHY: the per-leader cap (SPEC §4.2/§12) must reach checkCaps scoped to THAT leader — and be absent (null),
    // not 0, when unset: 0 would block every open.
    const capped: CopybotConfig = {
      user: CONFIG_DEFAULTS.user,
      leaders: [{ address: LEADER, enabled: true, maxTotalExposureSol: 2.5, overrides: {} }],
    };
    expect(effectiveFor(capped, LEADER).leaderMaxTotalExposureSol).toBe(2.5);
    expect(effectiveFor(CONFIG_DEFAULTS, LEADER).leaderMaxTotalExposureSol).toBeNull();
    expect(
      effectiveFor(capped, 'UnknownLeaderXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX')
        .leaderMaxTotalExposureSol,
    ).toBeNull();
  });
});

describe('config · execution group', () => {
  it('effectiveFor returns the user execution defaults with no override', () => {
    expect(effectiveFor(CONFIG_DEFAULTS, LEADER).execution).toEqual(CONFIG_DEFAULTS.user.execution);
  });

  it('a leader sparsely overrides one execution field, the rest inherit', () => {
    // WHY: a volatile-token leader may need more slippage without touching the other execution tunables.
    const cfg: CopybotConfig = {
      user: CONFIG_DEFAULTS.user,
      leaders: [
        {
          address: LEADER,
          enabled: true,
          maxTotalExposureSol: null,
          overrides: { execution: { slippageBps: 300 } },
        },
      ],
    };
    const ex = effectiveFor(cfg, LEADER).execution;
    expect(ex.slippageBps).toBe(300);
    expect(ex.dustTokenRaw).toBe(CONFIG_DEFAULTS.user.execution.dustTokenRaw); // sibling preserved
    expect(ex.reshapeBinDeadbandSol).toBe(CONFIG_DEFAULTS.user.execution.reshapeBinDeadbandSol);
  });

  it('a partial execution blob merges onto defaults (no silent reset of the other tunables)', () => {
    const cfg = parseConfig(JSON.stringify({ user: { execution: { minSellOutLamports: 1 } } }));
    expect(cfg.user.execution.minSellOutLamports).toBe(1);
    expect(cfg.user.execution.slippageBps).toBe(CONFIG_DEFAULTS.user.execution.slippageBps);
  });
});

describe('config · rugSl windowSeconds bound (finding #154)', () => {
  // WHY (#154): the rug-SL tracker prunes price samples to RUG_SL_RETAIN_MS, so a windowSeconds beyond that could
  // never be observed and the stop-loss would silently never fire. The schema bound must EQUAL the tracker retention
  // (in seconds) so the two can't drift — assert the boundary against RUG_SL_RETAIN_MS itself, not a copied literal.
  const boundSeconds = RUG_SL_RETAIN_MS / 1000;
  const withWindow = (windowSeconds: number): CopybotConfig => ({
    ...CONFIG_DEFAULTS,
    user: { ...CONFIG_DEFAULTS.user, rugSl: { ...CONFIG_DEFAULTS.user.rugSl, windowSeconds } },
  });

  it('the schema max EQUALS the tracker retention (accept AT the bound, reject just beyond it)', () => {
    expect(CopybotConfigSchema.safeParse(withWindow(boundSeconds)).success).toBe(true);
    expect(CopybotConfigSchema.safeParse(withWindow(boundSeconds + 1)).success).toBe(false);
  });

  it('a window within the bound is accepted (the default 60s and just under the bound both validate)', () => {
    expect(CopybotConfigSchema.safeParse(withWindow(60)).success).toBe(true);
    expect(CopybotConfigSchema.safeParse(withWindow(boundSeconds - 1)).success).toBe(true);
  });

  it('the bound also holds on the leader-override path (RugSlSchema.partial() keeps the max)', () => {
    // WHY: overrides use RugSlSchema.partial(), which only makes fields optional — it must NOT drop the .max, else a
    // per-leader window could smuggle past the user-level guard and re-open the same silent-never-fire hole.
    const cfg: CopybotConfig = {
      ...CONFIG_DEFAULTS,
      leaders: [
        {
          address: LEADER,
          enabled: true,
          maxTotalExposureSol: null,
          overrides: { rugSl: { windowSeconds: boundSeconds + 1 } },
        },
      ],
    };
    expect(CopybotConfigSchema.safeParse(cfg).success).toBe(false);
  });
});

describe('config · caps rate-limit pairing (idx18)', () => {
  // WHY (idx18): checkCaps enforces the sliding-window rate limit only when BOTH the count and the window are set
  // (its `&&` guard). A half-configured pair (one set, one null) silently disables the cap — a safety guardrail
  // failing OPEN. The schema must reject a half-set pair at write time so a rate limit can never vanish at runtime.
  const withRateLimit = (
    maxOpensPerWindow: number | null,
    windowMinutes: number | null,
  ): CopybotConfig => ({
    ...CONFIG_DEFAULTS,
    user: {
      ...CONFIG_DEFAULTS.user,
      caps: { ...CONFIG_DEFAULTS.user.caps, maxOpensPerWindow, windowMinutes },
    },
  });

  it('accepts both-set (a real rate limit) and both-null (rate limit off)', () => {
    expect(CopybotConfigSchema.safeParse(withRateLimit(10, 10)).success).toBe(true);
    expect(CopybotConfigSchema.safeParse(withRateLimit(null, null)).success).toBe(true);
  });

  it('rejects a count with no window (the fail-OPEN half-config the finding targets)', () => {
    expect(CopybotConfigSchema.safeParse(withRateLimit(10, null)).success).toBe(false);
  });

  it('rejects a window with no count (the reverse half-config — also a silently-off limit)', () => {
    expect(CopybotConfigSchema.safeParse(withRateLimit(null, 10)).success).toBe(false);
  });
});
