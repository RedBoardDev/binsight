/**
 * Copy-bot · Inc.3b step 5 — `ev:executed` → runtime resolution (PURE routing, INC3B-PLAN §3).
 *
 * The brain keeps ONE ev:executed consumer + PEL drain; each confirm must reach the runtime that OWNS it.
 * Resolution order:
 *   1. `ev.userId` — stamped by the coffre since 3b step 2 (authoritative: the tenant that published the command).
 *   2. positionPubkey ownership — position pubkeys are per-user ephemeral keys, globally unique on the shared
 *      wallet (covers deploy-window messages that predate the userId field).
 *   3. commandId ownership — the deferred-continuation stashes; commandIds are disjoint across users by
 *      derivation (deriveCommandId folds the userId).
 * No match ⇒ undefined: the caller decides (a close is ACKED only because the reconcile backstop covers it; a
 * sell falls back to the wallet context).
 */

/** The minimal runtime surface routing needs (structural — `UserRuntime` satisfies it; tests stub it). */
export interface RoutableRuntime {
  readonly userId: string;
  ownsOurPosition(ourPosition: string): boolean;
  ownsCommand(commandId: string): boolean;
}

/** The identifiers an `ev:executed` payload may carry for routing. */
export interface ExecutedRouteIds {
  userId?: string;
  positionPubkey?: string;
  commandId?: string;
}

/** Resolve the runtime an ev:executed confirm belongs to, or undefined when none owns it. */
export function resolveExecutedTarget<R extends RoutableRuntime>(
  runtimes: ReadonlyMap<string, R>,
  ids: ExecutedRouteIds,
): R | undefined {
  if (ids.userId !== undefined) {
    const byUser = runtimes.get(ids.userId);
    if (byUser) return byUser;
    // Unknown userId (e.g. a user whose runtime is not booted): fall through to ownership — a close confirm for a
    // mirror some runtime still holds must never be dropped on a stale tenant id.
  }
  if (ids.positionPubkey !== undefined) {
    for (const rt of runtimes.values()) if (rt.ownsOurPosition(ids.positionPubkey)) return rt;
  }
  if (ids.commandId !== undefined) {
    for (const rt of runtimes.values()) if (rt.ownsCommand(ids.commandId)) return rt;
  }
  return undefined;
}
