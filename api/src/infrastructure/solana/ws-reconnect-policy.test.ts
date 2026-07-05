import { describe, expect, it } from 'vitest';
import {
  BACKOFF_BASE_MS,
  BACKOFF_MAX_MS,
  isSilentTooLong,
  nextBackoffMs,
  reconnectDelayMs,
  SILENCE_TIMEOUT_MS,
} from './ws-reconnect-policy';

describe('nextBackoffMs — exponential growth, capped', () => {
  it('doubles each attempt so an outage backs off quickly instead of hammering the endpoint', () => {
    // WHY: a flapping endpoint must not be retried in a tight loop — each failure widens the gap geometrically.
    let backoff = BACKOFF_BASE_MS;
    backoff = nextBackoffMs(backoff);
    expect(backoff).toBe(2000);
    backoff = nextBackoffMs(backoff);
    expect(backoff).toBe(4000);
    backoff = nextBackoffMs(backoff);
    expect(backoff).toBe(8000);
  });

  it('never exceeds the cap so an extended outage still retries about every 30s (never gives up)', () => {
    // WHY (never-miss): the subscriber reconnects FOREVER — the delay must plateau, not grow unbounded, or a long
    // outage would push the next retry hours away and the WS trigger would stay dark far past recovery.
    let backoff = BACKOFF_MAX_MS;
    for (let i = 0; i < 5; i++) backoff = nextBackoffMs(backoff);
    expect(backoff).toBe(BACKOFF_MAX_MS);
    // Also caps mid-climb: a value just under 2× the cap clamps to exactly the cap.
    expect(nextBackoffMs(BACKOFF_MAX_MS - 1)).toBe(BACKOFF_MAX_MS);
  });
});

describe('reconnectDelayMs — capped-backoff floor + bounded deterministic jitter', () => {
  it('is at least the capped backoff so the retry never fires sooner than the schedule intends', () => {
    // WHY: jitter only ever ADDS spread; it must never shorten the delay below the backoff floor, which would
    // defeat the exponential back-pressure and let a flapping endpoint be hammered.
    for (let seed = 0; seed < 20; seed++) {
      expect(reconnectDelayMs(BACKOFF_BASE_MS, seed)).toBeGreaterThanOrEqual(BACKOFF_BASE_MS);
    }
  });

  it('keeps jitter strictly below 25% of the backoff so the delay stays within one predictable window', () => {
    // WHY: the spread de-syncs many clients reconnecting at once WITHOUT letting any single client drift far from
    // its scheduled slot — bound the added jitter to < backoff * 0.25.
    const backoff = 8000;
    for (let seed = 0; seed < 50; seed++) {
      const delay = reconnectDelayMs(backoff, seed);
      expect(delay).toBeGreaterThanOrEqual(backoff);
      expect(delay).toBeLessThan(backoff + backoff * 0.25);
    }
  });

  it('is deterministic for a given seed (a monotonic request id, not a PRNG)', () => {
    // WHY: the jitter source is the subscriber's nextReqId — same seed must yield the same delay, so the schedule
    // is reproducible and unit-testable rather than depending on Math.random.
    expect(reconnectDelayMs(4000, 3)).toBe(reconnectDelayMs(4000, 3));
    expect(reconnectDelayMs(4000, 3)).toBe(reconnectDelayMs(4000, 10)); // 3 % 7 === 10 % 7 → same jitter
  });

  it('yields exactly the capped backoff when the seed makes jitter zero', () => {
    // WHY: a seed that is a multiple of the modulus contributes no jitter — the delay must then equal the floor
    // exactly, proving the jitter term is purely additive.
    expect(reconnectDelayMs(4000, 0)).toBe(4000);
    expect(reconnectDelayMs(4000, 7)).toBe(4000);
  });

  it('caps the floor at the max even when a stale backoff overshoots', () => {
    // WHY: the floor uses the CAPPED backoff, so a backoff beyond the ceiling still schedules around the cap, never
    // the raw (huge) value.
    expect(reconnectDelayMs(BACKOFF_MAX_MS * 4, 0)).toBe(BACKOFF_MAX_MS);
  });
});

describe('isSilentTooLong — backstop window', () => {
  it('does not fire before or exactly at the threshold (silence alone is not death — never churn a healthy idle link)', () => {
    // WHY #52: an idle-but-alive subscription is legitimately silent; tripping at/under the window would reconnect a
    // perfectly healthy connection. The boundary is exclusive (`>`), so exactly SILENCE_TIMEOUT_MS elapsed is NOT dead.
    const now = 1_000_000;
    expect(isSilentTooLong(now, now)).toBe(false);
    expect(isSilentTooLong(now - (SILENCE_TIMEOUT_MS - 1), now)).toBe(false);
    expect(isSilentTooLong(now - SILENCE_TIMEOUT_MS, now)).toBe(false);
  });

  it('fires once elapsed exceeds the threshold (backstop for a socket the keepalive check somehow missed)', () => {
    const now = 1_000_000;
    expect(isSilentTooLong(now - (SILENCE_TIMEOUT_MS + 1), now)).toBe(true);
  });

  it('honors a custom timeout', () => {
    expect(isSilentTooLong(0, 500, 500)).toBe(false);
    expect(isSilentTooLong(0, 501, 500)).toBe(true);
  });
});
