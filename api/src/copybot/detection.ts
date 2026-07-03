/**
 * Copy-bot · Inc.2 — detection I/O adapters (listSignaturesSince + classify), WITHOUT the Meteora SDK.
 * Provides the `DetectorDeps` for the `LeaderDetector` (pure no-miss core). The tx building (SDK) is elsewhere
 * (brain). Pagination/no-miss-guardrail logic taken from the P1 CLI (proven).
 */
import { DLMM_PROGRAM_ID } from '@binsight/shared';
import type { Connection, PublicKey } from '@solana/web3.js';
import {
  buildDetectedEvents,
  type PoolMetaLookup,
  poolsOf,
} from '../domain/copybot/classify-dlmm-tx';
import type { DetectedEvent } from '../domain/copybot/events';
import type { ClassifyResult, DetectorDeps, SigInfo } from '../domain/copybot/leader-detector';
import type { LoadedPoolMeta } from '../domain/dlmm';
import type { OnchainPoolMetaReader } from '../infrastructure/solana/dlmm/pool-meta';
import type { HeliusTokenMetadataGateway } from '../infrastructure/solana/token-metadata-gateway';

const REPLAY_LIMIT = 25;
const SIG_PAGE = 1000;
const MAX_POLL_PAGES = 25;
const TX_FETCH_RETRIES = 3; // a WS notification can outrun tx availability at the RPC read replica
const TX_FETCH_RETRY_MS = 350; // short backoff between null-tx refetches (fast-close path)
// A null pool-meta read (the WS outran the LbPair account's availability at the RPC replica, or a brand-new pool the
// leader opened seconds after creation) must NEVER be cached forever: a permanently-cached null blinds the bot to
// EVERY subsequent event on that pool — each is built with amounts 0 / nonSolMint null → routed to 'ignore' → the
// leader's open is silently never copied (the cardinal sin). Cache the null for only this SHORT TTL so a later
// successful read values the pool; the on-chain reconcile backstop covers the specific event valued while degraded.
const POOL_META_NULL_TTL_MS = 15_000;
// getParsedTransactions is NOT gated by the per-call RPC limiter, and one oversized batched call over a large
// signature backlog can itself trip a provider 429 (degrading every process that shares the Helius key). Cap each
// call so a huge backlog fans out into bounded requests instead of one giant one. 100 is Solana's documented
// getParsedTransactions batch soft-limit and keeps a single call comfortably under provider payload/rate limits.
const CLASSIFY_TX_BATCH = 100;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Split into order-preserving chunks of at most `size` (pure; `size` must be > 0). */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** getParsedTransactions in bounded batches (CLASSIFY_TX_BATCH), concatenating results in input order so the
 *  returned array stays index-aligned with `signatures` (the no-miss backbone relies on that alignment). */
async function getParsedTransactionsBatched(
  conn: Connection,
  signatures: string[],
  opts: Parameters<Connection['getParsedTransactions']>[1],
): Promise<Awaited<ReturnType<Connection['getParsedTransactions']>>> {
  const out: Awaited<ReturnType<Connection['getParsedTransactions']>> = [];
  for (const batch of chunk(signatures, CLASSIFY_TX_BATCH)) {
    const res = await conn.getParsedTransactions(batch, opts);
    for (const tx of res) out.push(tx);
  }
  return out;
}

export function makeDetectionDeps(args: {
  conn: Connection;
  pk: PublicKey;
  poolReader: OnchainPoolMetaReader;
  tokenMeta: HeliusTokenMetadataGateway;
  onEvent: DetectorDeps['onEvent'];
  persist?: DetectorDeps['persist'];
  onGap?: DetectorDeps['onGap'];
  /** Optional SHARED pool-meta cache (Inc.3b: one deps object per watched leader — leaders sharing a pool must
   *  not each pay the meta read). Defaults to a per-deps private cache (the single-leader behavior). Holds only
   *  RESOLVED (non-null) metas — a null read is tracked separately under a short TTL (never cached permanently). */
  poolMetaCache?: Map<string, LoadedPoolMeta | null>;
  /** Observability: called with the pool address each time a DLMM pool's meta read returns null during classify, i.e.
   *  the pool's events are valued DEGRADED (amounts 0 / nonSolMint null) until the meta resolves. */
  onPoolMetaUnavailable?: (lbPair: string) => void;
  /** Injectable clock (the null-meta TTL). Defaults to `Date.now`; overridden in tests for deterministic expiry. */
  now?: () => number;
}): DetectorDeps {
  const { conn, pk, poolReader, tokenMeta, onEvent, persist, onGap } = args;
  const now = args.now ?? Date.now;
  const poolMetaCache = args.poolMetaCache ?? new Map<string, LoadedPoolMeta | null>();
  const nullMetaAt = new Map<string, number>(); // lbPair → ms of the last null read (short-TTL negative cache, per-deps)
  const getPoolMeta = async (lbPair: string): Promise<LoadedPoolMeta | null> => {
    const cached = poolMetaCache.get(lbPair);
    if (cached) return cached; // a resolved pool meta is immutable → cache forever (shared across leaders on this pool)
    const nulledAt = nullMetaAt.get(lbPair);
    if (nulledAt !== undefined && now() - nulledAt < POOL_META_NULL_TTL_MS) return null; // negative cache still warm — don't re-hammer RPC
    const meta = await poolReader.loadPoolMeta(lbPair);
    if (meta) {
      poolMetaCache.set(lbPair, meta);
      nullMetaAt.delete(lbPair);
      return meta;
    }
    nullMetaAt.set(lbPair, now()); // remember the null for the SHORT TTL only — a later read re-resolves the pool
    args.onPoolMetaUnavailable?.(lbPair);
    return meta;
  };

  return {
    async listSignaturesSince(until: string | undefined): Promise<SigInfo[]> {
      // Cold start: bounded recent history (we don't replay the whole wallet).
      if (until === undefined) {
        const page = await conn.getSignaturesForAddress(pk, { limit: REPLAY_LIMIT });
        return page.filter((s) => s.err === null).map((s) => ({ signature: s.signature }));
      }
      // Poll: COMPLETE pagination of everything newer than `until` (contiguous sweep, no-miss).
      const out: SigInfo[] = [];
      let before: string | undefined;
      for (let p = 1; ; p++) {
        const batch = await conn.getSignaturesForAddress(pk, { until, before, limit: SIG_PAGE });
        if (batch.length === 0) break;
        for (const s of batch) if (s.err === null) out.push({ signature: s.signature });
        before = batch[batch.length - 1]?.signature;
        if (batch.length < SIG_PAGE) break;
        if (p >= MAX_POLL_PAGES) {
          throw new Error(
            `poll: ${MAX_POLL_PAGES} full pages without reaching the cursor — retry on the next poll.`,
          );
        }
      }
      return out;
    },

    async classify(signatures: string[]): Promise<ClassifyResult> {
      const opts = { maxSupportedTransactionVersion: 0 as const, commitment: 'confirmed' as const };
      let txs = await getParsedTransactionsBatched(conn, signatures, opts);
      // Refetch ONLY the still-null slots (WS outran RPC availability). Keeps the poll cheap; makes the live
      // WS close/open path resolve in ~1s instead of waiting for the next cursor poll.
      for (let attempt = 0; attempt < TX_FETCH_RETRIES && txs.some((t) => t === null); attempt++) {
        await sleep(TX_FETCH_RETRY_MS);
        const missing = signatures.filter((_, i) => txs[i] === null);
        const refetched = await getParsedTransactionsBatched(conn, missing, opts);
        let m = 0;
        txs = txs.map((t) => (t === null ? (refetched[m++] ?? null) : t));
      }
      // Any slot STILL null after the retry loop is UNRESOLVED (not "resolved non-DLMM"): the detector must
      // NOT advance the cursor past it — it re-lists and retries until it resolves or a LOUD gap is accepted.
      const unresolved = new Set<string>();
      for (let i = 0; i < signatures.length; i++) {
        const sig = signatures[i];
        if (sig && txs[i] === null) unresolved.add(sig);
      }
      const pools = new Set<string>();
      for (const tx of txs) for (const pl of poolsOf(tx)) pools.add(pl);
      await Promise.all([...pools].map((pl) => getPoolMeta(pl)));
      const poolMeta: PoolMetaLookup = (lbPair) => poolMetaCache.get(lbPair) ?? null;

      // ONE entry per signature (the no-miss backbone stays keyed BY SIGNATURE); its payload is the 1..N
      // position-events the tx produced (finding #37: a multi-position tx no longer collapses to one event).
      const map = new Map<string, DetectedEvent[]>();
      for (let i = 0; i < signatures.length; i++) {
        const sig = signatures[i];
        if (!sig) continue;
        const evs = buildDetectedEvents(sig, txs[i] ?? null, poolMeta);
        if (evs.length > 0) map.set(sig, evs);
      }
      // Symbol resolution: one batched call over EVERY position-event across all signatures.
      const allEvents = [...map.values()].flat();
      const mints = [
        ...new Set(allEvents.map((e) => e.nonSolMint).filter((m): m is string => !!m)),
      ];
      if (mints.length > 0) {
        const metas = await tokenMeta.resolve(mints);
        for (const e of allEvents) {
          if (e.nonSolMint) e.nonSolSymbol = metas.get(e.nonSolMint)?.symbol ?? null;
        }
      }
      return { events: map, unresolved };
    },

    onEvent,
    persist,
    onGap,
  };
}

export const DLMM_LOG_MARKER = DLMM_PROGRAM_ID;
