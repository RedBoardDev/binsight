import type { FetchMiddleware } from '@solana/web3.js';
import { sleep } from '@/util/sleep';
import { currentCodePath } from './code-path';
import type { CreditMeter } from './credit-meter';

/**
 * Evenly-spaced slot reserver. `reserve()` hands out the next instant a call may run and advances
 * its cursor by `1000/rps` ms, so consecutive reservations are spaced at least that far apart — a
 * steady drip that never bursts above `rps`. The clock is injected so the spacing is unit-testable.
 */
export class Spacer {
  private cursor = 0;
  private readonly spacingMs: number;

  constructor(
    rps: number,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.spacingMs = 1000 / Math.max(0.001, rps);
  }

  reserve(): number {
    return this.reserveAtLeast(0);
  }

  /** Like reserve(), but never earlier than `floor` — and the cursor advances to the ACTUAL slot.
   *  Used to pin the overall bucket to a call's true fire time when a sub-limit pushes it later,
   *  so no two calls land in the same overall slot (which would burst past the rate → 429). */
  reserveAtLeast(floor: number): number {
    const at = Math.max(this.now(), this.cursor + this.spacingMs, floor);
    this.cursor = at;
    return at;
  }
}

export interface SolanaRpcLimits {
  /** Overall JSON-RPC ceiling (requests/sec). */
  rps: number;
  /** getProgramAccounts sub-limit (requests/sec). */
  gpaRps: number;
  /** Digital Asset Standard (getAsset*) sub-limit (requests/sec). */
  dasRps: number;
  /** sendTransaction sub-limit (requests/sec). */
  sendRps: number;
}

// Helius Digital Asset Standard methods — their own (tighter) bucket.
const DAS_METHODS = new Set([
  'getAsset',
  'getAssetProof',
  'getAssetsByOwner',
  'getAssetsByGroup',
  'getAssetsByCreator',
  'getAssetsByAuthority',
  'getSignaturesForAsset',
  'searchAssets',
]);

/** Extract the JSON-RPC method from a request body (handles batch arrays). */
export function rpcMethodOf(body: unknown): string | undefined {
  if (typeof body !== 'string') return undefined;
  try {
    const parsed = JSON.parse(body);
    const first = Array.isArray(parsed) ? parsed[0] : parsed;
    return typeof first?.method === 'string' ? first.method : undefined;
  } catch {
    return undefined;
  }
}

/**
 * How many JSON-RPC calls a request body actually contains — the length of a batch array, else 1.
 *
 * A batch is ONE HTTP request but N billable calls, and providers rate-limit it as N. Counting it as
 * one reservation is what let a 50-call batch blow straight past a 10 rps ceiling: the provider
 * answered 429, web3.js retried the whole batch up to 5 times, and the retry storm was invisible to
 * both the limiter and the credit meter (which under-reported the spend ~50-fold).
 */
export function rpcBatchSizeOf(body: unknown): number {
  if (typeof body !== 'string') return 1;
  try {
    const parsed = JSON.parse(body);
    return Array.isArray(parsed) ? Math.max(1, parsed.length) : 1;
  } catch {
    return 1;
  }
}

/**
 * Connection-level rate limiter for a Solana RPC provider. Every JSON-RPC call passes through
 * `gate()`: it reserves a slot in the overall bucket AND in its method-class bucket
 * (getProgramAccounts / DAS / sendTransaction), then waits until both allow it — so we never exceed
 * the provider's plan. Defaults match the Helius free tier (10 rps overall, gPA 5, DAS 2, send 1)
 * and are overridable via env. Two instances back two Connections (a LIVE lane + a BACKFILL lane); the
 * overall budget is split between them (see composition) so a history backfill never starves the live
 * snapshot path, while together they stay under the provider plan (which prevents the 429 storms).
 */
export class SolanaRpcRateLimiter {
  private readonly overall: Spacer;
  private readonly gpa: Spacer;
  private readonly das: Spacer;
  private readonly send: Spacer;
  // Cumulative call counts per method-class — instrumentation to size the Helius tier on real usage.
  private readonly callCounts = { total: 0, gpa: 0, das: 0, send: 0, other: 0 };
  // Per-EXACT-method counts (getMultipleAccounts, getParsedTransaction, getSignaturesForAddress, …) so
  // the coarse gpa/das/send/other split can be broken down to the precise credit-heavy call.
  private readonly byMethod: Record<string, number> = {};

  constructor(
    limits: SolanaRpcLimits,
    private readonly now: () => number = () => Date.now(),
    // Shared credit meter (optional so the unit tests construct the limiter bare). When present, every
    // gated method is recorded with its active code path.
    private readonly meter?: CreditMeter,
  ) {
    this.overall = new Spacer(limits.rps, now);
    this.gpa = new Spacer(limits.gpaRps, now);
    this.das = new Spacer(limits.dasRps, now);
    this.send = new Spacer(limits.sendRps, now);
  }

  /** Reserve the next instant `method` may run; both the overall and the method bucket advance.
   *  The method bucket is reserved first, then the overall bucket is pinned to at-least that time,
   *  so a sub-limited call's overall slot reflects when it really fires (no coincident bursts).
   *
   *  `weight` is the number of JSON-RPC calls the request carries (a batch of N reserves N slots and
   *  costs N credits — see {@link rpcBatchSizeOf}). Reservations are monotonic, so the LAST slot is the
   *  latest: waiting for it covers all N. */
  reserveSlot(method: string | undefined, weight = 1): number {
    const sub = this.subFor(method);
    const m = method ?? 'unknown';
    let at = 0;
    for (let i = 0; i < Math.max(1, weight); i++) {
      this.callCounts.total++;
      this.byMethod[m] = (this.byMethod[m] ?? 0) + 1;
      // Credit attribution: every gated JSON-RPC call costs its method's credits on the active code path.
      this.meter?.record(m, { codePath: currentCodePath() });
      if (sub === this.gpa) this.callCounts.gpa++;
      else if (sub === this.das) this.callCounts.das++;
      else if (sub === this.send) this.callCounts.send++;
      else this.callCounts.other++;
      const subAt = sub ? sub.reserve() : 0;
      at = this.overall.reserveAtLeast(subAt);
    }
    return at;
  }

  /** Cumulative RPC call counts by method-class + per-exact-method since boot — credit/tier instrumentation. */
  stats(): {
    total: number;
    gpa: number;
    das: number;
    send: number;
    other: number;
    byMethod: Record<string, number>;
  } {
    return { ...this.callCounts, byMethod: { ...this.byMethod } };
  }

  async gate(method: string | undefined, weight = 1): Promise<void> {
    const wait = this.reserveSlot(method, weight) - this.now();
    if (wait > 0) await sleep(wait);
  }

  private subFor(method: string | undefined): Spacer | null {
    if (!method) return null;
    if (method === 'getProgramAccounts') return this.gpa;
    if (method === 'sendTransaction') return this.send;
    if (DAS_METHODS.has(method)) return this.das;
    return null;
  }

  /** web3.js fetch middleware: read the JSON-RPC method AND how many calls the body carries, gate on
   *  the resulting budget, then let it proceed. */
  middleware(): FetchMiddleware {
    return (info, init, fetch) => {
      // Proceed with the fetch whether the gate resolves OR rejects (a sleep/abort must never strand
      // the request — web3.js would then hang forever waiting on a promise that never settles).
      void this.gate(rpcMethodOf(init?.body), rpcBatchSizeOf(init?.body)).then(
        () => fetch(info, init),
        () => fetch(info, init),
      );
    };
  }
}
