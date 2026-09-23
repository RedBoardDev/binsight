import type { LiveEvent } from '@binsight/shared';

const BULK_WINDOW_MS = 8000;

/** Groups same-kind events of ONE wallet that land within a short window into a single notification.
 *  Per wallet: every channel routes by `event.wallet`, so a group spanning two wallets would reach only
 *  the first wallet's subscribers, listing the other wallet's pairs. */
export class BulkBuffer {
  private readonly buffers = new Map<string, { events: LiveEvent[]; timer: NodeJS.Timeout }>();
  private seq = 0;

  constructor(private readonly onFlush: (event: LiveEvent) => Promise<void>) {}

  add(event: LiveEvent): void {
    const key = `${event.kind}|${event.wallet ?? ''}`;
    const existing = this.buffers.get(key);
    if (existing) {
      existing.events.push(event);
      return;
    }
    const timer = setTimeout(() => this.flush(key), BULK_WINDOW_MS);
    this.buffers.set(key, { events: [event], timer });
  }

  private flush(key: string): void {
    const buf = this.buffers.get(key);
    if (!buf) return;
    this.buffers.delete(key);
    clearTimeout(buf.timer);
    if (buf.events.length === 1) {
      void this.onFlush(buf.events[0]!);
      return;
    }
    const first = buf.events[0]!;
    const kind = first.kind;
    void this.onFlush({
      ...first,
      id: `${Date.now()}-${this.seq++}`,
      title: `${buf.events.length} × ${kind.replace(/_/g, ' ')}`,
      body: buf.events.map((e) => e.pair ?? '?').join(', '),
      data: { count: buf.events.length },
    });
  }
}
