/**
 * Copy-bot — Discord operator alert sink (SPEC §10). These tests encode the WHY:
 *  - no `DISCORD_WEBHOOK_URL` ⇒ NO sink, ONE boot log, NO fetch (nothing without config);
 *  - the delivery POLICY: only operator-actionable events page (pinned OR the explicit allowlist),
 *    never a routine feed row;
 *  - ONE POST per `DISCORD_MIN_INTERVAL_MS` (rate-limit friendly), duplicates within the dedup window dropped;
 *  - a failing fetch is swallowed — a dead webhook must NEVER break the bot (the #1 pillar).
 */
import type { Logger } from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CODE_REGISTRY } from '@/domain/copybot/observability/codes';
import type { CopyEvent } from '@/domain/copybot/observability/event';
import {
  createDiscordAlertSink,
  DISCORD_MIN_INTERVAL_MS,
  DiscordAlertSink,
  formatDiscordContent,
  shouldAlertOperator,
} from './alert';

function fakeLog(): Logger & { warn: ReturnType<typeof vi.fn>; info: ReturnType<typeof vi.fn> } {
  return { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } as unknown as Logger & {
    warn: ReturnType<typeof vi.fn>;
    info: ReturnType<typeof vi.fn>;
  };
}

function event(over: Partial<CopyEvent> = {}): CopyEvent {
  return {
    code: 'failsafe.failed',
    severity: 'error',
    category: 'FAILSAFE',
    audience: 'feed',
    pinned: true,
    ts: 1234,
    eventTs: 1234,
    ctx: { userId: 'system', wallet: 'W', process: 'coffre' },
    stage: 'failsafe',
    outcome: 'failed',
    correlationId: 'cmd-1',
    reason: 'close manually',
    ...over,
  } as unknown as CopyEvent;
}

const url = 'https://discord.example/webhook';

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('shouldAlertOperator — the delivery policy', () => {
  it('pages every PINNED event (the operator-actionable set)', () => {
    expect(shouldAlertOperator({ pinned: true, code: 'failsafe.failed' })).toBe(true);
  });
  it('pages the explicit non-pinned allowlist (config fail-closed activation is internal but must page)', () => {
    expect(shouldAlertOperator({ pinned: false, code: 'system.config_invalid_fallback' })).toBe(
      true,
    );
  });
  it('does NOT page a routine non-pinned event (an open/close feed row is not operator business)', () => {
    expect(shouldAlertOperator({ pinned: false, code: 'lifecycle.open_confirmed' })).toBe(false);
  });
  it('pages the RPC/WS-outage alert (`system.detection_stale`) as configured in the registry — never merely logs it (#167)', () => {
    // WHY: the brain runs BOTH never-miss detection AND execution on ONE Helius endpoint (a SPOF). If that key
    // outages, the poll + reconcile loops go blind while the heartbeat stays green — the ONLY v1 mitigation is this
    // out-of-band page so the operator swaps the key. `CopyEvents.emit` fires the alert sink for PINNED events only,
    // so if a future edit un-pins `system.detection_stale` the page silently degrades to a log line. Assert the
    // registry's ACTUAL pinned flag still carries the code through the delivery policy — this fails loudly on that
    // regression instead of going quietly un-paged.
    const meta = CODE_REGISTRY['system.detection_stale'];
    expect(meta.pinned).toBe(true);
    expect(
      shouldAlertOperator({ pinned: meta.pinned ?? false, code: 'system.detection_stale' }),
    ).toBe(true);
  });
});

describe('formatDiscordContent', () => {
  it('carries the code + severity emoji + key fields on one bounded line', () => {
    const content = formatDiscordContent(
      event({ leader: 'LEAD', pool: 'POOL', ourPosition: 'POS' }),
    );
    expect(content).toContain('failsafe.failed');
    expect(content).toContain('🚨');
    expect(content).toContain('user system');
    expect(content).toContain('leader LEAD');
    expect(content).toContain('reason close manually');
  });
});

describe('createDiscordAlertSink', () => {
  it('returns undefined + logs ONCE (no fetch) when the URL is unset', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const log = fakeLog();
    expect(createDiscordAlertSink(undefined, log)).toBeUndefined();
    expect(createDiscordAlertSink('', log)).toBeUndefined();
    expect(log.info).toHaveBeenCalledTimes(2);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('DiscordAlertSink — delivery, rate limit, dedup, resilience', () => {
  it('POSTs { content } as JSON to the URL for a pinned event', async () => {
    vi.useFakeTimers();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null));
    const sink = new DiscordAlertSink(url, fakeLog());
    sink.offer(event());
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [gotUrl, init] = fetchSpy.mock.calls[0]!;
    expect(gotUrl).toBe(url);
    expect(init!.method).toBe('POST');
    expect(JSON.parse(init!.body as string).content).toContain('failsafe.failed');
    expect(init!.signal).toBeInstanceOf(AbortSignal); // timeout-bounded
  });

  it('does NOT POST a non-operator event (policy filter)', async () => {
    vi.useFakeTimers();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null));
    const sink = new DiscordAlertSink(url, fakeLog());
    sink.offer(event({ pinned: false, code: 'lifecycle.open_confirmed' }));
    await vi.advanceTimersByTimeAsync(DISCORD_MIN_INTERVAL_MS + 10);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('drops a duplicate (same user/code/correlationId) within the dedup window', async () => {
    vi.useFakeTimers();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null));
    const sink = new DiscordAlertSink(url, fakeLog());
    sink.offer(event());
    sink.offer(event()); // identical key → dropped
    await vi.advanceTimersByTimeAsync(DISCORD_MIN_INTERVAL_MS * 2);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(sink.stats().droppedDuplicates).toBe(1);
  });

  it('spaces two DISTINCT alerts by at least DISCORD_MIN_INTERVAL_MS (rate limit)', async () => {
    vi.useFakeTimers();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null));
    const sink = new DiscordAlertSink(url, fakeLog());
    sink.offer(event({ correlationId: 'a' }));
    sink.offer(event({ correlationId: 'b' }));
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchSpy).toHaveBeenCalledTimes(1); // first sent immediately
    await vi.advanceTimersByTimeAsync(DISCORD_MIN_INTERVAL_MS);
    expect(fetchSpy).toHaveBeenCalledTimes(2); // second only after the interval
  });

  it('does not dedup across DIFFERENT users (two users, same code → two alerts)', async () => {
    vi.useFakeTimers();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null));
    const sink = new DiscordAlertSink(url, fakeLog());
    sink.offer(event({ ctx: { userId: 'u1', wallet: 'W', process: 'brain' } }));
    sink.offer(event({ ctx: { userId: 'u2', wallet: 'W', process: 'brain' } }));
    await vi.advanceTimersByTimeAsync(DISCORD_MIN_INTERVAL_MS * 2);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('swallows a REJECTED fetch (a dead webhook must never break the bot) and keeps draining', async () => {
    vi.useFakeTimers();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network down'));
    const log = fakeLog();
    const sink = new DiscordAlertSink(url, log);
    expect(() => sink.offer(event({ correlationId: 'a' }))).not.toThrow();
    sink.offer(event({ correlationId: 'b' }));
    await vi.advanceTimersByTimeAsync(DISCORD_MIN_INTERVAL_MS * 2);
    expect(fetchSpy).toHaveBeenCalledTimes(2); // a dead POST never head-of-line-blocks the next alert
    expect(log.warn).toHaveBeenCalled();
  });
});
