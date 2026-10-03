import {
  type EventStreamOptions,
  openEventStream,
  type StreamState,
} from '@app/lib/sse/eventStream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Long enough for the silence watchdog to stay out of the visibility tests.
const HOUR_MS = 3_600_000;

class FakeEventSource extends EventTarget {
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSED = 2;
  readyState = this.CONNECTING;
  isClosed = false;

  close(): void {
    this.readyState = this.CLOSED;
    this.isClosed = true;
  }

  open(): void {
    this.readyState = this.OPEN;
    this.dispatchEvent(new Event('open'));
  }

  send(type: string, data: string): void {
    this.dispatchEvent(new MessageEvent(type, { data }));
  }

  failWith(readyState: number): void {
    this.readyState = readyState;
    this.dispatchEvent(new Event('error'));
  }
}

class FakeVisibility {
  isPageHidden = false;
  private readonly listeners = new Set<() => void>();

  readonly isHidden = (): boolean => this.isPageHidden;

  readonly subscribe = (onChange: () => void): (() => void) => {
    this.listeners.add(onChange);
    return () => this.listeners.delete(onChange);
  };

  change(isHidden: boolean): void {
    this.isPageHidden = isHidden;
    for (const listener of this.listeners) {
      listener();
    }
  }
}

const startStream = (overrides: Partial<EventStreamOptions> = {}) => {
  const sources: FakeEventSource[] = [];
  const states: StreamState[] = [];
  const events: [string, string][] = [];
  const visibility = new FakeVisibility();
  const onRefused = vi.fn();
  const stream = openEventStream({
    url: '/api/v1/events',
    eventTypes: ['heartbeat'],
    onEvent: (type, data) => events.push([type, data]),
    onStateChange: (state) => states.push(state),
    onRefused,
    reconnectDelay: (attempt) => 1_000 * 2 ** attempt,
    createEventSource: () => {
      const source = new FakeEventSource();
      sources.push(source);
      return source;
    },
    visibility,
    ...overrides,
  });
  const latest = (): FakeEventSource => {
    const source = sources.at(-1);
    if (source === undefined) {
      throw new Error('no event source was created');
    }
    return source;
  };
  return { stream, sources, states, events, visibility, onRefused, latest };
};

describe('openEventStream', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reports the connection and passes each named event on', () => {
    const { states, events, latest } = startStream();

    latest().open();
    latest().send('heartbeat', '{"type":"heartbeat"}');

    expect(states).toEqual(['connecting', 'open']);
    expect(events).toEqual([['heartbeat', '{"type":"heartbeat"}']]);
  });

  it('lets the browser retry a dropped connection on its own', () => {
    const { states, sources, latest } = startStream();
    latest().open();

    latest().failWith(0);

    expect(states.at(-1)).toBe('reconnecting');
    expect(sources).toHaveLength(1);
  });

  it('reconnects itself with a growing delay when the server refuses the stream', () => {
    const { sources, onRefused, latest } = startStream();

    latest().failWith(2);
    expect(onRefused).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(999);
    expect(sources).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(sources).toHaveLength(2);

    latest().failWith(2);
    vi.advanceTimersByTime(1_999);
    expect(sources).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(sources).toHaveLength(3);
  });

  it('starts the delays over once a connection opens', () => {
    const { sources, latest } = startStream();
    latest().failWith(2);
    vi.advanceTimersByTime(1_000);
    latest().open();

    latest().failWith(2);
    vi.advanceTimersByTime(1_000);

    expect(sources).toHaveLength(3);
  });

  it('reconnects when the server falls silent for 45 seconds', () => {
    const { sources, latest } = startStream();
    latest().open();

    vi.advanceTimersByTime(30_000);
    latest().send('heartbeat', '{}');
    vi.advanceTimersByTime(44_999);
    expect(sources[0]?.isClosed).toBe(false);
    vi.advanceTimersByTime(1);

    expect(sources[0]?.isClosed).toBe(true);
    vi.advanceTimersByTime(1_000);
    expect(sources).toHaveLength(2);
  });

  it('pauses after a minute in a hidden tab and resumes when the tab is shown', () => {
    const { states, sources, visibility, latest } = startStream({ silenceTimeoutMs: HOUR_MS });
    latest().open();

    visibility.change(true);
    vi.advanceTimersByTime(60_000);
    expect(states.at(-1)).toBe('paused');
    expect(sources[0]?.isClosed).toBe(true);

    visibility.change(false);
    expect(sources).toHaveLength(2);
    expect(states.at(-1)).toBe('connecting');
  });

  it('keeps the stream when the tab comes back within a minute', () => {
    const { sources, visibility, latest } = startStream({ silenceTimeoutMs: HOUR_MS });
    latest().open();

    visibility.change(true);
    vi.advanceTimersByTime(59_000);
    visibility.change(false);
    vi.advanceTimersByTime(60_000);

    expect(sources).toHaveLength(1);
    expect(sources[0]?.isClosed).toBe(false);
  });

  it('closes everything on close', () => {
    const { stream, sources, latest } = startStream();
    latest().failWith(2);

    stream.close();
    vi.advanceTimersByTime(60_000);

    expect(sources).toHaveLength(1);
    expect(sources[0]?.isClosed).toBe(true);
  });
});
