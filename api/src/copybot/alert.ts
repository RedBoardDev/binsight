/**
 * Copy-bot — Discord operator alerts (SPEC §10). The out-of-band channel for operator-actionable events:
 * definitive close/sign failures ("VERIFY/CLOSE MANUALLY"), `system.command_quarantined`,
 * `system.detection_stale`, repeated reconcile failures (they surface AS detection_stale) and the config
 * fail-closed activation. Everything `pinned` in the CODE_REGISTRY plus the explicit non-pinned allowlist below.
 *
 * Injected as `CopyEvents`' `alertSink` at boot (brain + coffre). The emitter forwards EVERY emitted event;
 * THIS module owns the delivery policy (`shouldAlertOperator`) so routing rules live in one place.
 *
 * Rate-limit friendly by construction: an in-process FIFO sends at most one webhook POST per
 * `DISCORD_MIN_INTERVAL_MS`, and duplicates of the same `(userId, code, correlationId)` within
 * `DISCORD_DEDUP_WINDOW_MS` are dropped (and counted). NEVER throws and is a no-op without config —
 * a dead webhook must not break the bot (the copy-bot's #1 pillar).
 */
import type { Logger } from 'pino';
import { CODE_REGISTRY, type CopyCode } from '@/domain/copybot/observability/codes';
import type { CopyEvent, CopySeverity } from '@/domain/copybot/observability/event';

/** Hard cap on the webhook POST so a hung endpoint can never stall the queue for long. */
const DISCORD_TIMEOUT_MS = 5_000;
/** Min spacing between webhook POSTs — well under Discord's per-webhook limit (~30 req/min), burst-proof. */
export const DISCORD_MIN_INTERVAL_MS = 2_000;
/** Duplicates of the same (userId, code, correlationId) within this window are dropped (operator noise cap).
 *  Longer than the emitter's own 120s LRU: the sink is SHARED across per-user emitters, so it also collapses
 *  cross-emitter repeats (e.g. a reconcile retrying the same failed close every 30s tick). */
export const DISCORD_DEDUP_WINDOW_MS = 300_000;
/** Bound on queued alerts — an alert storm must degrade to dropped messages, never to unbounded memory. */
export const DISCORD_MAX_QUEUE = 50;
/** Discord rejects `content` over 2000 chars; keep margin for the truncation marker. */
export const DISCORD_CONTENT_MAX = 1_900;

/**
 * Non-pinned codes that must STILL page the operator. `system.config_invalid_fallback` is audience:'internal'
 * (the user never sees the bot's own config corruption) but its activation means a user is silently fail-closed —
 * exactly what an operator must know out-of-band (SPEC §10).
 */
const OPERATOR_ALERT_CODES: ReadonlySet<CopyCode> = new Set<CopyCode>([
  'system.config_invalid_fallback',
]);

/** PURE delivery policy: everything pinned (the operator-actionable set) + the explicit allowlist above. */
export function shouldAlertOperator(e: Pick<CopyEvent, 'pinned' | 'code'>): boolean {
  return e.pinned || OPERATOR_ALERT_CODES.has(e.code);
}

const SEVERITY_EMOJI: Record<CopySeverity, string> = {
  error: '🚨',
  warn: '⚠️',
  info: 'ℹ️',
};

/** PURE: one Discord `content` line — severity emoji + code + registry title + the event's key fields. */
export function formatDiscordContent(e: CopyEvent): string {
  const title = CODE_REGISTRY[e.code]?.title ?? '';
  const head = `${SEVERITY_EMOJI[e.severity] ?? ''} **${e.code}**${title ? ` — ${title}` : ''}`;
  const fields = [
    `process ${e.ctx.process}`,
    `user ${e.ctx.userId}`,
    e.leader && `leader ${e.leader}`,
    e.pool && `pool ${e.pool}`,
    e.ourPosition && `pos ${e.ourPosition}`,
    e.reason && `reason ${e.reason}`,
  ].filter((f): f is string => Boolean(f));
  const content = `${head}\n${fields.join(' · ')}`;
  return content.length > DISCORD_CONTENT_MAX
    ? `${content.slice(0, DISCORD_CONTENT_MAX)}…`
    : content;
}

/**
 * The Discord webhook sink: policy filter → dedup → bounded FIFO → one POST per `DISCORD_MIN_INTERVAL_MS`.
 * `offer` is synchronous and NEVER throws (it is called from inside `CopyEvents.emit`'s hot path).
 */
export class DiscordAlertSink {
  private readonly queue: string[] = [];
  /** (userId, code, correlationId) → last-delivered ms; entries older than the window are re-deliverable. */
  private readonly lastSentAt = new Map<string, number>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inflight = false;
  private nextAllowedAt = 0;
  /** Duplicates dropped inside the dedup window (observability: surfaced via `stats()` + a debug log). */
  private droppedDuplicates = 0;
  /** Alerts dropped because the queue was full (an alert storm must not grow memory unbounded). */
  private droppedOverflow = 0;

  constructor(
    private readonly url: string,
    private readonly log: Logger,
  ) {}

  /** Enqueue an event for delivery if the policy selects it and it isn't a within-window duplicate. */
  offer(e: CopyEvent): void {
    try {
      if (!shouldAlertOperator(e)) return;
      const now = Date.now();
      const key = `${e.ctx.userId}:${e.code}:${e.correlationId ?? ''}`;
      const seenAt = this.lastSentAt.get(key);
      if (seenAt !== undefined && now - seenAt < DISCORD_DEDUP_WINDOW_MS) {
        this.droppedDuplicates += 1;
        this.log.debug({ key }, 'discord alert duplicate dropped');
        return;
      }
      this.lastSentAt.set(key, now);
      this.pruneDedup(now);
      if (this.queue.length >= DISCORD_MAX_QUEUE) {
        this.droppedOverflow += 1;
        this.log.warn(
          { dropped: this.droppedOverflow },
          'discord alert queue full — alert dropped',
        );
        return;
      }
      this.queue.push(formatDiscordContent(e));
      this.schedule();
    } catch (err) {
      // Loop guard: the sink is called from inside emit — an alert bug must never break the hot path.
      this.log.warn({ err: (err as Error).message }, 'discord alert offer failed');
    }
  }

  /** Drop/dedup counters — exposed for tests + operator debugging. */
  stats(): { queued: number; droppedDuplicates: number; droppedOverflow: number } {
    return {
      queued: this.queue.length,
      droppedDuplicates: this.droppedDuplicates,
      droppedOverflow: this.droppedOverflow,
    };
  }

  /** Evict expired dedup entries so the map stays bounded by the alert rate, not the process lifetime. */
  private pruneDedup(now: number): void {
    for (const [key, at] of this.lastSentAt) {
      if (now - at >= DISCORD_DEDUP_WINDOW_MS) this.lastSentAt.delete(key);
    }
  }

  /** Arm the pump for the next allowed send slot (idempotent while a timer/POST is already pending). */
  private schedule(): void {
    if (this.timer !== null || this.inflight || this.queue.length === 0) return;
    const wait = Math.max(0, this.nextAllowedAt - Date.now());
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.send();
    }, wait);
    this.timer.unref?.();
  }

  private async send(): Promise<void> {
    const content = this.queue.shift();
    if (content === undefined) return;
    this.inflight = true;
    this.nextAllowedAt = Date.now() + DISCORD_MIN_INTERVAL_MS;
    try {
      await fetch(this.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content }),
        signal: AbortSignal.timeout(DISCORD_TIMEOUT_MS),
      });
    } catch (err) {
      // Best-effort: a failed POST is warn-logged and the alert is NOT retried (the journal row is durable;
      // retrying here would head-of-line-block fresher alerts behind a dead webhook).
      this.log.warn({ err: (err as Error).message }, 'discord alert POST failed');
    } finally {
      this.inflight = false;
      this.schedule();
    }
  }
}

/**
 * Build the Discord alert sink for `CopyEvents`. Returns `undefined` when `DISCORD_WEBHOOK_URL` is unset —
 * disabled, with ONE boot log line so the operator knows alerts are off. Call ONCE per process and share the
 * returned sink across every emitter, so the rate limit + dedup are process-wide.
 */
export function createDiscordAlertSink(
  url: string | undefined,
  log: Logger,
): ((e: CopyEvent) => void) | undefined {
  if (!url) {
    log.info('discord operator alerts disabled (DISCORD_WEBHOOK_URL unset)');
    return undefined;
  }
  const sink = new DiscordAlertSink(url, log);
  return (e: CopyEvent): void => sink.offer(e);
}
