/**
 * Shared WS keepalive / liveness policy for the Helius subscribers (logsSubscribe + transactionSubscribe).
 *
 * WHY (#52): a subscription is legitimately silent when the watched wallets are idle, so silence ALONE is not a
 * death signal — yet Helius closes a silent-but-alive client at its ~10-min inactivity timer, and the old 300s
 * "silence heuristic" both churned HEALTHY idle connections and detected genuinely dead ones late. We instead send
 * a benign JSON-RPC frame on every tick (keeps the connection alive; its reply — even a JSON-RPC error for an
 * unknown method — advances liveness), and treat a run of UNANSWERED keepalives (not silence) as death, which also
 * catches a truly dead socket far earlier than any long silence window.
 *
 * The transports are undici's WHATWG `WebSocket`, which does not expose a protocol-level `ping()`, so the keepalive
 * is a data frame rather than a WS ping. The socket I/O itself is integration-checked; the death decision below is
 * pure and unit-tested.
 */

/** Send a keepalive frame this often. ≤ 55s keeps us comfortably under Helius's ~10-min idle cutoff. */
export const WS_PING_INTERVAL_MS = 30_000;

/** Consecutive unanswered keepalives that prove the socket is dead (~2 ticks ≈ 60s ≪ the old 300s silence window). */
export const WS_MAX_UNANSWERED_PINGS = 2;

/** Pure: is the connection dead? True once `unansweredPings` keepalives have gone unanswered since the last frame. */
export function isWsDead(unansweredPings: number, max: number = WS_MAX_UNANSWERED_PINGS): boolean {
  return unansweredPings >= max;
}
