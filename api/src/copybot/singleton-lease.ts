/**
 * Copy-bot · shared SINGLETON LEASE (pure decision + boot/renew wiring). A Redis `SET key NX PX ttl` lease gives a
 * process EXCLUSIVE ownership of a role so two overlapping instances (e.g. a rolling redeploy) can never both run.
 * The coffre uses it so a 2nd vault can't double-sign in-flight commands (#150); the brain uses it so a 2nd brain
 * can't split the `ev:executed` consumer and silently strand multi-tx open continuations (A6-04).
 *
 * This module imports NO signing authority, so it is safe on BOTH sides of the brain/coffre firewall (F1b) — the
 * brain can reuse the SAME split-brain guard the coffre proved, without ever importing a coffre-signing module.
 */
import type { Logger } from 'pino';

export const LEASE_TTL_MS = 30_000; // a crashed holder's lease auto-expires within this window so a restart can re-acquire
export const LEASE_RENEW_MS = LEASE_TTL_MS / 2; // renew well before expiry so a live holder never spuriously loses the lease

/** The result of ONE renew attempt: Redis answered (ok = still ours / lost) OR the call errored (transient?). */
export type LeaseRenewOutcome = { ok: boolean } | { error: string };

export type LeaseRenewAction =
  | { action: 'renewed' } // the lease is still ours → refresh the last-success clock, keep running
  | { action: 'exit'; reason: 'lost' | 'expired' } // exclusivity provably gone → exit (split-brain guard, #150)
  | { action: 'retry' }; // a TRANSIENT renew error, still within the TTL → log and retry next tick

/**
 * PURE (#150): decide a lease-renew tick. The split-brain guard must fire not only when Redis EXPLICITLY reports the
 * lease lost (`ok=false`) but ALSO when a renew merely keeps ERRORING: once `nowMs - lastSuccessMs > ttlMs`, a renew
 * has not SUCCEEDED within the TTL, so the lease has provably EXPIRED at Redis — a second holder can now acquire it —
 * regardless of WHY the renews failed. Only a transient error still inside the TTL is safe to retry; without this an
 * outage longer than the TTL silently loses exclusivity forever (the old `.catch` just logged).
 */
export function planLeaseRenew(
  outcome: LeaseRenewOutcome,
  nowMs: number,
  lastSuccessMs: number,
  ttlMs: number,
): LeaseRenewAction {
  if ('error' in outcome)
    return nowMs - lastSuccessMs > ttlMs
      ? { action: 'exit', reason: 'expired' }
      : { action: 'retry' };
  return outcome.ok ? { action: 'renewed' } : { action: 'exit', reason: 'lost' };
}

/** The lease-relevant slice of the bus (decoupled from RedisBus for testability). */
export interface LeaseBus {
  acquireLease(key: string, instanceId: string, ttlMs: number): Promise<boolean>;
  renewLease(key: string, instanceId: string, ttlMs: number): Promise<boolean>;
}

/**
 * Start the ttl/2 renew loop for an already-ACQUIRED lease and enforce the #150 split-brain guard: a renew that
 * resolves `!ok` (lease lost) OR keeps erroring past the TTL (lease provably expired at Redis) BOTH mean exclusivity
 * is gone → `onLost` (default: exit the process). Only a transient error still within the TTL is logged and retried.
 * Returns the interval timer (so a graceful shutdown can clear it). Injectable clock/`onLost` for tests.
 */
export function startLeaseRenewLoop(deps: {
  bus: LeaseBus;
  key: string;
  instanceId: string;
  role: string; // 'brain' | 'coffre' — for the log line
  log: Pick<Logger, 'error'>;
  ttlMs?: number;
  renewMs?: number;
  now?: () => number;
  onLost?: (reason: 'lost' | 'expired') => void;
}): ReturnType<typeof setInterval> {
  const ttlMs = deps.ttlMs ?? LEASE_TTL_MS;
  const renewMs = deps.renewMs ?? LEASE_RENEW_MS;
  const now = deps.now ?? Date.now;
  const onLost = deps.onLost ?? (() => process.exit(1));
  let lastSuccessMs = now(); // the lease is ours as of the acquire; renews must keep it fresh
  const decide = (outcome: LeaseRenewOutcome): void => {
    const step = planLeaseRenew(outcome, now(), lastSuccessMs, ttlMs);
    if (step.action === 'renewed') {
      lastSuccessMs = now();
      return;
    }
    if (step.action === 'retry') {
      deps.log.error(
        { err: (outcome as { error: string }).error, role: deps.role },
        'lease renew failed (transient, still within TTL — will retry next tick)',
      );
      return;
    }
    deps.log.error(
      { key: deps.key, instanceId: deps.instanceId, role: deps.role, reason: step.reason },
      '🔒 lost the singleton lease — exiting to avoid a split-brain',
    );
    onLost(step.reason);
  };
  return setInterval(() => {
    void deps.bus
      .renewLease(deps.key, deps.instanceId, ttlMs)
      .then((ok) => decide({ ok }))
      .catch((e) => decide({ error: (e as Error).message }));
  }, renewMs);
}
