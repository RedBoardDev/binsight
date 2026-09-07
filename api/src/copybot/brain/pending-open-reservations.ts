/**
 * Copy-bot · TTL-bounded PENDING-OPEN reservations (PURE, no I/O). A leader OPEN is copied by a handler that only
 * calls `registry.open(...)` at the END. For MULTI-TX opens (two-sided buy→open, Token-2022 create→deposit, wide
 * split) the open handler RETURNS before `registry.open` — that runs later in an ev:executed continuation. During
 * that window `registry.hasOpen(pos)` is still false, so a follow-up leader add on the same position would re-route
 * to a SECOND open (real-money double open). A reservation marks a position as "open in flight" the moment we route
 * it to `open`, so the follow-up event routes to resync/ignore (like a normal add) instead of a duplicate open.
 *
 * Self-healing by design: each entry carries a timestamp and is ignored (and lazily deleted) once older than the
 * TTL. A leaked reservation therefore only suppresses re-opening the SAME leader position for ≤TTL — it can NEVER
 * cause a missed close or a permanent block, and NEVER a double open. The TTL must exceed the longest multi-tx open
 * window (buy/create land + deposit land) so the reservation stays live until `registry.open` clears it.
 */
/** Sizing/scoping of a caps-gated in-flight open — folded by `capsState` into the wallet-level cap totals so a
 *  burst of concurrent opens can't each pass against a stale registry-only snapshot (A1-01/A1-02). */
export interface OpenReservationMeta {
  /** the leader whose position this open copies — scope of the per-leader exposure cap. */
  leader: string;
  /** the candidate's non-SOL mint (per-token concurrency cap), or null for a SOL-only / non-token open. */
  mint: string | null;
  /** the SOL this open will deploy — the exposure caps. */
  sizeSol: number;
}

export interface PendingOpenReservations {
  /** Mark `pos` as having an open in flight (called at dispatch, before the open handler runs). Pass `meta` ONCE
   *  the open has PASSED its caps gate so a concurrent open counts it against the wallet-level caps; a later call
   *  WITHOUT `meta` (a continuation hop) refreshes the TTL and PRESERVES the existing meta. */
  reserve(pos: string, meta?: OpenReservationMeta): void;
  /** True iff `pos` has a non-stale reservation. Deletes the entry lazily if stale (self-healing). */
  isPending(pos: string): boolean;
  /** Clear `pos`'s reservation (called at each `registry.open` site, keyed by the leader position). */
  clear(pos: string): void;
  /** Number of live entries (test/observability only). */
  size(): number;
  /** Non-stale, caps-GATED reservations (those given `meta`), EXCLUDING `exceptPos` — `capsState` folds these into
   *  the wallet-level totals so a burst of concurrent opens can't each pass against a stale registry-only snapshot. */
  activeOpens(exceptPos?: string): OpenReservationMeta[];
}

export function createPendingOpenReservations(
  ttlMs: number,
  now: () => number = Date.now,
): PendingOpenReservations {
  const reserved = new Map<string, { at: number; meta?: OpenReservationMeta }>();
  return {
    reserve: (pos, meta) => {
      const prev = reserved.get(pos);
      // A continuation hop re-reserves without meta: refresh the TTL, keep the meta stamped at the caps gate.
      reserved.set(pos, { at: now(), meta: meta ?? prev?.meta });
    },
    isPending: (pos) => {
      const e = reserved.get(pos);
      if (e === undefined) return false;
      if (now() - e.at >= ttlMs) {
        reserved.delete(pos); // stale → self-heal (a leaked reservation clears itself after the TTL)
        return false;
      }
      return true;
    },
    clear: (pos) => {
      reserved.delete(pos);
    },
    size: () => reserved.size,
    activeOpens: (exceptPos) => {
      const cutoff = now() - ttlMs;
      const out: OpenReservationMeta[] = [];
      for (const [pos, e] of reserved) {
        if (pos === exceptPos) continue;
        if (e.at <= cutoff) continue; // stale (lazy read — not deleted here; isPending self-heals)
        if (e.meta !== undefined) out.push(e.meta);
      }
      return out;
    },
  };
}
