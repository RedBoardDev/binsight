/**
 * CreditMeter — credit-precise RPC telemetry.
 *
 * Every billable Helius call is reported via `record()`; the meter attributes its CREDIT cost (not just
 * a call count) per exact method, per code path, and per wallet, keeps a bounded ring of recent calls
 * for a live feed, and derives pure STRUCTURAL anomaly signals (an Enhanced call happened, a legacy
 * getProgramAccounts happened) — pure visibility, never call-blocking. It holds NO I/O — the clock is
 * injected so the flush day-bucket is unit testable, and the in-memory ledger (plus its persisted daily
 * rollup) is what `/debug/rpc` serves.
 *
 * Credit costs follow the Helius credit model.
 */

/** Per-method credit cost — Helius credit model. `default` covers any std JSON-RPC method not listed. */
export const CREDIT_COST: Record<string, number> = {
  getProgramAccounts: 10, // legacy gPA — 10 credits (Helius credit model)
  getProgramAccountsV2: 1, // paginated gPA — 1 credit (Helius credit model)
  // Owner-indexed paginated token read. Billed as the sibling V2 method; the Helius credit table
  // does not list it separately, so this is an assumption, not a citation.
  getTokenAccountsByOwnerV2: 1,
  getMultipleAccounts: 1, // ≤100 accounts — 1 credit (Helius credit model)
  getAccountInfo: 1, // 1 credit (Helius credit model)
  getSignaturesForAddress: 1, // 1 credit (Helius credit model)
  getTransaction: 1, // 1 credit (Helius credit model)
  getParsedTransaction: 1, // 1 credit (Helius credit model)
  sendTransaction: 1, // 1 credit (Helius credit model)
  getBalance: 1, // 1 credit (Helius credit model)
  getLatestBlockhash: 1, // 1 credit (Helius credit model)
  das: 10, // DAS getAsset* — 10 credits (Helius credit model)
  enhancedTx: 100, // Enhanced Transactions API — 100 credits (Helius credit model)
  // WebSocket billing, per Helius' docs: "metered at 2 credits per 0.1 MB of uncompressed streamed
  // data", plus 1 credit to open a connection. `wsData` is therefore one STARTED 0.1 MB — the
  // transport accumulates bytes and records a unit as each boundary is crossed, never per message.
  // It used to be priced as 20 credits per started MEGABYTE, which billed a whole megabyte for the
  // first byte of every connection: with the socket reconnecting every few minutes that inflated the
  // WebSocket line ~10x in rpc_credit_daily, and every budget projection built on it.
  wsOpen: 1,
  wsData: 2,
  default: 1, // std JSON-RPC — 1 credit (Helius credit model)
};

/** Bytes per billed WebSocket unit (0.1 MB) — the boundary the transport charges on. */
export const WS_BYTES_PER_CREDIT_UNIT = 100_000;

const MS_PER_DAY = 86_400_000; // UTC-day bucket width for the flush rollup day key
const RING_CAPACITY = 2000; // bounded recent-call ring (live feed); oldest evicted past this
const RING_TAIL = 50; // entries `stats()` exposes as the live tail

export type Severity = 'low' | 'medium' | 'high';

export interface Anomaly {
  kind: 'enhanced-used' | 'legacy-gpa';
  detail: string;
  severity: Severity;
}

/** A single recorded call, kept in the bounded ring for the live feed. */
export interface RingEntry {
  at: number;
  method: string;
  codePath: string;
  wallet: string | null;
  credits: number;
  ok: boolean;
}

export interface CreditStats {
  totalCredits: number;
  totalCalls: number;
  byMethod: Record<string, number>;
  byCodePath: Record<string, number>;
  byWallet: Record<string, number>;
  ringTail: RingEntry[];
}

/** A per-(UTC-day, exact method, wallet, code path) credit delta — the unit the 60s flush appends to the
 *  `rpc_credit_daily` rollup. `wallet` is '' when the call isn't attributable to a wallet (so it maps
 *  straight onto that table's columns + PK). */
export interface CreditFlushRow {
  day: number;
  method: string;
  wallet: string;
  codePath: string;
  calls: number;
  credits: number;
}

export interface RecordOpts {
  wallet?: string;
  codePath?: string;
  ok?: boolean;
}

/** UTC-day index for `at` (ms) — the flush rollup day bucket. */
const utcDay = (at: number): number => Math.floor(at / MS_PER_DAY);

export class CreditMeter {
  private totalCredits = 0;
  private totalCalls = 0;
  private readonly byMethod: Record<string, number> = {};
  private readonly byCodePath: Record<string, number> = {};
  private readonly byWallet: Record<string, number> = {};
  // Bounded live-feed ring; oldest entries are evicted once it exceeds RING_CAPACITY.
  private readonly ring: RingEntry[] = [];
  // Per-(day,method,wallet,codePath) deltas accumulated SINCE the last drainForFlush() — the DB-flush
  // buffer. Distinct from the cumulative counters above: a drain resets ONLY this, never stats().
  private flushBuffer = new Map<string, CreditFlushRow>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  /** Credit cost for a recorded call, from the per-method map (or the std JSON-RPC default). */
  private creditsFor(method: string): number {
    return CREDIT_COST[method] ?? CREDIT_COST.default!;
  }

  /** Record one billable call: add its credits to every cumulative counter + the flush buffer. */
  record(method: string, opts: RecordOpts = {}): void {
    const at = this.now();
    const credits = this.creditsFor(method);
    const codePath = opts.codePath ?? 'unknown';
    const wallet = opts.wallet ?? null;

    this.totalCredits += credits;
    this.totalCalls += 1;
    this.byMethod[method] = (this.byMethod[method] ?? 0) + credits;
    this.byCodePath[codePath] = (this.byCodePath[codePath] ?? 0) + credits;
    if (wallet) this.byWallet[wallet] = (this.byWallet[wallet] ?? 0) + credits;

    this.pushRing({ at, method, codePath, wallet, credits, ok: opts.ok ?? true });
    this.bumpFlush(at, method, wallet, codePath, credits);
  }

  /** Cumulative credit ledger + the recent live tail — the payload behind `/debug/rpc`. */
  stats(): CreditStats {
    return {
      totalCredits: this.totalCredits,
      totalCalls: this.totalCalls,
      byMethod: { ...this.byMethod },
      byCodePath: { ...this.byCodePath },
      byWallet: { ...this.byWallet },
      ringTail: this.ring.slice(-RING_TAIL),
    };
  }

  /** The per-(day,method,wallet,codePath) credit deltas accumulated SINCE the previous drain, then RESET
   *  the buffer (the cumulative stats() counters are untouched). The 60s timer flushes these into the
   *  `rpc_credit_daily` rollup; a drain with no new calls since the last one returns [] (so the timer
   *  never re-writes an already-persisted window). */
  drainForFlush(): CreditFlushRow[] {
    const rows = [...this.flushBuffer.values()];
    this.flushBuffer.clear();
    return rows;
  }

  /** Pure STRUCTURAL anomaly signals derived from the cumulative ledger — informational visibility
   *  (a credit-heavy call shape happened), never call-blocking. */
  anomalies(): Anomaly[] {
    const out: Anomaly[] = [];
    // Enhanced API is BANNED from steady-state (100 credits/call drained the key) — any use is a flag.
    if ((this.byMethod.enhancedTx ?? 0) > 0) {
      out.push({
        kind: 'enhanced-used',
        detail: `enhancedTx credits=${this.byMethod.enhancedTx}`,
        severity: 'high',
      });
    }
    // Legacy getProgramAccounts is 10× getProgramAccountsV2 — its presence on a recurring path is waste.
    if ((this.byMethod.getProgramAccounts ?? 0) > 0) {
      out.push({
        kind: 'legacy-gpa',
        detail: `getProgramAccounts credits=${this.byMethod.getProgramAccounts}`,
        severity: 'medium',
      });
    }
    return out;
  }

  /** Accumulate one call into the flush buffer under its (day,method,wallet,codePath) key. A null wallet
   *  maps to '' (matches the rpc_credit_daily column default). */
  private bumpFlush(
    at: number,
    method: string,
    wallet: string | null,
    codePath: string,
    credits: number,
  ): void {
    const day = utcDay(at);
    const w = wallet ?? '';
    const key = `${day}\u0000${method}\u0000${w}\u0000${codePath}`;
    const cur = this.flushBuffer.get(key);
    if (cur) {
      cur.calls += 1;
      cur.credits += credits;
    } else {
      this.flushBuffer.set(key, { day, method, wallet: w, codePath, calls: 1, credits });
    }
  }

  private pushRing(entry: RingEntry): void {
    this.ring.push(entry);
    if (this.ring.length > RING_CAPACITY) this.ring.shift();
  }
}
