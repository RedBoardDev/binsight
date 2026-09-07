/**
 * Copy-bot · P1 — PURE part of classifying a tx (extracted from `watch-leader.ts` `classify()`).
 *
 * Given a parsed transaction + a SYNCHRONOUS pool-meta lookup (already loaded), produces ONE
 * `DetectedEvent` valued in SOL PER leader position the tx touches — `[]` if it isn't a DLMM tx (finding
 * #37: a multi-position tx must not collapse to one merged event). Leg routing (deposit →
 * `depositSol`, withdraw → `withdrawSol`, claim → `claimSol`) and the pool's non-SOL side live HERE, so they
 * are tested WITHOUT the network (cf. `classify-dlmm-tx.test.ts`, golden on open/close/claim/partial withdrawal).
 *
 * The non-SOL token's symbol is resolved elsewhere (batched I/O call in `watch-leader.ts`) → `nonSolSymbol`
 * stays `null` here. The byte decoding itself remains the binsight engine (`decodeDlmmLegs`, tested against
 * the real Event-CPI layout in `dlmm-event-decoder.test.ts`); this module owns NO infrastructure — the decoder
 * is injected as a `DlmmTxCodec` PORT (finding #59: domain purity) implemented by an infrastructure adapter.
 */
import { SOL_MINT } from '@binsight/shared';
import type { ParsedTransactionWithMeta } from '@solana/web3.js';
import type { DlmmLeg, LoadedPoolMeta } from '../dlmm';
import { legValueSol } from '../dlmm-pnl';
import type { DetectedEvent } from './events';

/** Synchronous pool→meta lookup (already loaded). `null` = unknown pool or not valuable in SOL. */
export type PoolMetaLookup = (lbPair: string) => LoadedPoolMeta | null;

/**
 * Injected PURE DLMM tx codec: byte/Anchor Event-CPI decode (`decodeDlmmLegs`/`hasDlmmEvents`) + log-label
 * parse (`parseInstruction`). Defined in the domain and supplied by an infrastructure adapter so this module
 * imports NO decoder from `src/infrastructure` (finding #59, dependency-cruiser rule `D1`). The concrete codec
 * (`infrastructure/solana/dlmm/dlmm-tx-codec.ts`) just composes the existing engine functions — behavior is
 * unchanged; this only inverts the dependency direction.
 */
export interface DlmmTxCodec {
  /** True iff the tx emitted any DLMM Event-CPI — the robust DLMM-detection signal, immune to 10KB log truncation. */
  hasDlmmEvents(tx: ParsedTransactionWithMeta): boolean;
  /** Normalize the tx's DLMM events into deposit/withdraw/claim/close legs. */
  decodeDlmmLegs(tx: ParsedTransactionWithMeta): DlmmLeg[];
  /** Best-effort human instruction label from (truncatable) logs; routing keys off `closed`, not this label. */
  parseInstruction(logs: string[]): string | null;
}

/** The pools (lbPair) touched by a tx — used to pre-load the metas (I/O) BEFORE the pure call. */
export function poolsOf(tx: ParsedTransactionWithMeta | null, codec: DlmmTxCodec): string[] {
  if (!tx) return [];
  return [...new Set(codec.decodeDlmmLegs(tx).map((l) => l.lbPair))];
}

/**
 * True iff `tx` has a value-bearing DEPOSIT (open/add) leg into a pool the caller marks UNRESOLVED — i.e. its
 * LbPair meta could not be read (a null on-chain read: a brand-new pool, or the RPC replica lagging the account).
 * Such a tx must be treated as UNRESOLVED by the detector (held + re-listed until the meta resolves), NOT committed:
 * a deposit valued against a null meta is `depositSol = 0` → dispatch routes it to 'ignore' → the leader's position
 * (and therefore its eventual CLOSE) is never mirrored — the cardinal sin (finding #162).
 *
 * ONLY deposit legs gate the hold. A close/withdraw needs NO meta to route (`closed` is decoded from the leg kind,
 * value-independent), so a pure close with a null meta must still FAST-PATH — holding a leader's exit is a fund
 * risk. `isPoolUnresolved` is supplied by the caller, which alone can tell a null READ (unresolved → retry) from a
 * resolved non-SOL pool (`solSide === null` → a legitimate, permanent 'ignore' that retrying would never change).
 * The empty-lbPair guard drops a decoder-degenerate pool-less deposit: it can never resolve, so holding it would
 * stall the cursor until the LOUD-gap cap instead of failing over — a real deposit always carries its lbPair.
 */
export function hasUnresolvedDepositLeg(
  tx: ParsedTransactionWithMeta | null,
  isPoolUnresolved: (lbPair: string) => boolean,
  codec: DlmmTxCodec,
): boolean {
  if (!tx || !codec.hasDlmmEvents(tx)) return false;
  return codec
    .decodeDlmmLegs(tx)
    .some((leg) => leg.kind === 'deposit' && leg.lbPair !== '' && isPoolUnresolved(leg.lbPair));
}

/**
 * Builds the `DetectedEvent`s of ONE tx — ONE event PER leader position touched (finding #37). `[]` if it isn't
 * a DLMM tx (no tx, or no DLMM Event-CPI). A pool that is present but not valuable in SOL (`solSide === null` /
 * meta absent) keeps the action with amounts at 0 and `nonSolMint = null` — we never lose the event, only the amount.
 *
 * WHY per-position (not per-tx): a single leader tx can touch TWO positions (close A + open B, an on-chain
 * rebalance across positions, a multi-position bot tx). Collapsing to one event (last-leg-wins + amounts summed
 * across positions) attributes the merged amounts to the last-decoded position and DROPS the other position's
 * action entirely — a full close of A would fall back to the 30s reconcile (delayed close = fund risk) and a
 * PARTIAL remove of A would be silently lost forever (the copy stays oversized). So we GROUP the decoded legs by
 * `leg.position` and build one event per group; amounts are summed only WITHIN a position.
 *
 * Single-position identity: a tx that touches exactly one position yields exactly ONE event, byte-identical to
 * the pre-#37 behavior (every real DLMM leg carries its own position; the standalone-close marker carries it too).
 *
 * DLMM-ness is gated on the decoded events (`hasDlmmEvents`), NOT on `logMessages`: Solana truncates logs at
 * 10KB, so a DLMM instruction that runs after a big bundle (e.g. a Jupiter zap) has no DLMM string in the
 * truncated logs — gating on logs would return null and PERMANENTLY MISS that leader open/close. `instruction`
 * stays a best-effort LABEL from the logs (`'(DLMM)'` when truncated); routing keys off `closed`, not the label.
 */
export function buildDetectedEvents(
  signature: string,
  tx: ParsedTransactionWithMeta | null,
  poolMeta: PoolMetaLookup,
  codec: DlmmTxCodec,
): DetectedEvent[] {
  if (!tx || !codec.hasDlmmEvents(tx)) return [];

  const instruction = codec.parseInstruction(tx.meta?.logMessages ?? []) ?? '(DLMM)';
  const blockTime = tx.blockTime ?? null;
  const legs = codec.decodeDlmmLegs(tx);

  // Group the legs by their position pubkey (the aggregation key). Real DLMM events (open/add/remove/claim/close)
  // all decode a `position`; an empty-position leg is a decoder degenerate. To keep the single-position identity
  // exact, when the tx touches at most ONE distinct position we route EVERY leg (including any stray empty-position
  // marker) into that single group — so a one-position tx is one event, identical to before.
  const distinct = [...new Set(legs.map((l) => l.position).filter((p) => p !== ''))];
  const soleGroup = distinct.length <= 1 ? (distinct[0] ?? '') : null;
  const groups = new Map<string, typeof legs>();
  for (const leg of legs) {
    const key = soleGroup ?? leg.position;
    const bucket = groups.get(key);
    if (bucket) bucket.push(leg);
    else groups.set(key, [leg]);
  }

  const events: DetectedEvent[] = [];
  for (const [groupPosition, groupLegs] of groups) {
    let depositSol = 0;
    let depositTokenRaw = 0; // raw NON-SOL units deposited — authoritative two-sided signal (decode, not the shape read)
    let withdrawSol = 0;
    let claimSol = 0;
    let closed = false; // a decoded 'close' leg (PositionClose) → robust close signal, independent of the log label
    let pool = '';
    let nonSolMint: string | null = null;
    for (const leg of groupLegs) {
      if (leg.kind === 'close') closed = true; // PositionClose leg → the leader closed the position
      if (leg.lbPair) pool = leg.lbPair; // a zero-amount close marker carries no pool → don't clobber the real one
      const meta = poolMeta(leg.lbPair);
      if (!meta || !meta.solSide) continue; // pool not valuable in SOL → action kept, without amount
      nonSolMint = meta.mintX === SOL_MINT ? meta.mintY : meta.mintX;
      const sol = legValueSol(leg, { binStep: meta.binStep, solSide: meta.solSide });
      if (leg.kind === 'deposit') {
        depositSol += sol;
        depositTokenRaw += Number(meta.mintX === SOL_MINT ? leg.amountY : leg.amountX); // the non-SOL leg's raw amount
      } else if (leg.kind === 'withdraw') withdrawSol += sol;
      else claimSol += sol;
    }

    events.push({
      signature,
      blockTime,
      instruction,
      depositSol,
      depositTokenRaw,
      withdrawSol,
      claimSol,
      closed,
      pool,
      position: groupPosition, // P2 tracker key; the group key IS the position (empty only for a degenerate no-position tx)
      nonSolMint,
      nonSolSymbol: null,
    });
  }

  return events;
}
