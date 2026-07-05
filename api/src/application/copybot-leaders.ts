/**
 * Copy-bot · Inc.4b — leader-onboarding SERVICE (API-side). Wraps the pure onboarding logic
 * (`domain/copybot/leader-onboard.ts`) with the two I/O touch points: the per-user config store (read the existing
 * leaders / persist the new one) and an on-chain DLMM-activity check. Adding a leader always creates it STOPPED —
 * the user presses Start later (SPEC §4.3).
 */
import type { Logger } from 'pino';
import type { ConfigStore } from '@/copybot/config-store';
import {
  applyNewLeaderConfig,
  type LeaderRejectReason,
  leaderRejectReason,
  type NewLeaderInput,
} from '@/domain/copybot/leader-onboard';

export type LeaderValidation = { ok: true } | { ok: false; reason: LeaderRejectReason };

export interface CopybotLeadersDeps {
  configStore: ConfigStore;
  /** True iff the address shows DLMM activity worth copying (current on-chain DLMM positions). */
  hasDlmmActivity: (address: string) => Promise<boolean>;
  log: Logger;
}

export class CopybotLeadersService {
  constructor(private readonly deps: CopybotLeadersDeps) {}

  /**
   * Validate a pasted leader address for `userId`: the deterministic checks first (malformed / own bot wallet /
   * already configured), then — only if those pass — the on-chain DLMM-activity check (so a no-DLMM wallet is
   * rejected). `ownAddress` is the user's own bot wallet (the self-copy guard).
   */
  async validate(
    userId: string,
    address: string,
    ownAddress: string | null,
  ): Promise<LeaderValidation> {
    const cfg = await this.deps.configStore.load(userId);
    const reason = leaderRejectReason({
      address,
      ownAddress,
      existingAddresses: cfg.leaders.map((l) => l.address),
    });
    if (reason) return { ok: false, reason };
    if (!(await this.deps.hasDlmmActivity(address)))
      return { ok: false, reason: 'no_dlmm_activity' };
    return { ok: true };
  }

  /**
   * Add a wizard-configured leader (STOPPED). The FIRST write for a brand-new user bases on `seedIfAbsent`, NOT
   * `load` (finding #159): `load` returns the ARMED `CONFIG_DEFAULTS` for a missing row (`user.enabled:true` + the
   * operator's default leader ENABLED), so persisting on top of it would silently arm a fresh non-SYSTEM user onto a
   * leader they never chose. `seedIfAbsent` instead seeds a non-SYSTEM user STOPPED (`user.enabled:false` + the
   * default leader STOPPED) on first write, returns an EXISTING row unchanged (`load` semantics), and still arms
   * SYSTEM (idx24). The appended leader is always STOPPED, so a fresh user ends up fully inert until they explicitly
   * arm. Re-runs the DETERMINISTIC validation (guards a duplicate/own-wallet race between validate and submit)
   * before persisting; the on-chain activity check is trusted from `validate` (it isn't repeated on write — the
   * wizard already gated on it). Returns the same validation shape on rejection.
   */
  async create(
    userId: string,
    input: NewLeaderInput,
    ownAddress: string | null,
  ): Promise<LeaderValidation> {
    // FIRST write bases on the tenant seed (non-SYSTEM ⇒ STOPPED), never the armed load-defaults for a missing row (finding #159).
    const cfg = await this.deps.configStore.seedIfAbsent(userId);
    const reason = leaderRejectReason({
      address: input.address,
      ownAddress,
      existingAddresses: cfg.leaders.map((l) => l.address),
    });
    if (reason) return { ok: false, reason };
    const next = applyNewLeaderConfig(cfg, input);
    await this.deps.configStore.save(userId, next); // validates shape + write policy; throws on invalid
    this.deps.log.info({ userId, leader: input.address }, 'copybot leader added (stopped)');
    return { ok: true };
  }
}
