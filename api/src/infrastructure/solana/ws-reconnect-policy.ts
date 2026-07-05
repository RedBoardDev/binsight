/**
 * Shared reconnect POLICY for the Helius WS subscribers (`HeliusSubscriber` logsSubscribe +
 * `HeliusTxSubscriber` transactionSubscribe).
 *
 * WHY: both subscribers reconnect forever with the SAME exponential-backoff-with-jitter schedule and the SAME
 * long-silence backstop. Two hand-copied copies mean a fix to one (a money-critical never-miss path) silently
 * skips the other. This module is the SINGLE SOURCE of that reconnect DECISION logic; each subscriber keeps its
 * own socket I/O. Pure + unit-tested. The keepalive-ping concern lives in `./ws-keepalive` (#52) — this builds on
 * it, it does not duplicate it.
 */

/** First reconnect delay, and the value backoff resets to after a clean (re)connect. */
export const BACKOFF_BASE_MS = 1000;
/** Ceiling on the reconnect delay: an extended outage still retries about every 30s — never gives up, never busy-loops. */
export const BACKOFF_MAX_MS = 30_000;
/**
 * Long-silence backstop before forcing a reconnect. A logsSubscribe/transactionSubscribe stream is legitimately
 * silent when the watched wallets are idle, so silence ALONE is not a death signal — this is only a backstop; the
 * unanswered-keepalive check (`isWsDead`, #52) trips far sooner and keeps healthy idle connections alive.
 */
export const SILENCE_TIMEOUT_MS = 300_000;

/** Jitter span as a fraction of the current backoff — spreads a reconnect storm so many clients don't retry in lockstep. */
const JITTER_FRACTION = 0.25;
/** Small modulus the jitter seed is folded over to derive a bounded [0, 1) multiplier without pulling in a PRNG. */
const JITTER_SEED_MODULO = 7;

/** Next backoff after a failed attempt: double it, capped at the max. Pure. */
export function nextBackoffMs(currentMs: number): number {
  return Math.min(currentMs * 2, BACKOFF_MAX_MS);
}

/**
 * Delay before the next reconnect attempt for the current backoff: the capped backoff floor plus a deterministic
 * jitter in `[0, backoff * JITTER_FRACTION)`. `seed` is the subscriber's monotonically increasing request id — a
 * cheap, dependency-free source that de-synchronises many clients reconnecting at once. The floor is the CAPPED
 * backoff, so the delay never dips below it (a never-miss path must keep retrying promptly, but not in lockstep).
 * Pure.
 */
export function reconnectDelayMs(backoffMs: number, seed: number): number {
  const jitter = Math.floor(
    backoffMs * JITTER_FRACTION * ((seed % JITTER_SEED_MODULO) / JITTER_SEED_MODULO),
  );
  return Math.min(backoffMs, BACKOFF_MAX_MS) + jitter;
}

/** Pure: has the connection been silent past the backstop window? (Death is normally caught earlier by `isWsDead`.) */
export function isSilentTooLong(
  lastMessageAt: number,
  now: number,
  timeoutMs: number = SILENCE_TIMEOUT_MS,
): boolean {
  return now - lastMessageAt > timeoutMs;
}
