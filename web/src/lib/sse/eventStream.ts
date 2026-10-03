export type StreamState = 'connecting' | 'open' | 'reconnecting' | 'paused';

// The part of EventSource the stream uses, so tests can hand it a fake.
export interface EventSourceConnection {
  readonly readyState: number;
  readonly CLOSED: number;
  addEventListener(type: string, listener: (event: Event) => void): void;
  close(): void;
}

export interface PageVisibility {
  readonly isHidden: () => boolean;
  readonly subscribe: (onChange: () => void) => () => void;
}

export interface EventStreamOptions {
  readonly url: string;
  readonly eventTypes: readonly string[];
  readonly onEvent: (type: string, data: string) => void;
  readonly onStateChange: (state: StreamState) => void;
  // The server refused the stream (an HTTP error such as 401): called before each of our own
  // reconnection attempts, so the caller can check whether the session is still valid.
  readonly onRefused: () => void;
  readonly reconnectDelay: (attempt: number) => number;
  readonly createEventSource?: (url: string) => EventSourceConnection;
  readonly visibility?: PageVisibility;
  readonly silenceTimeoutMs?: number;
  readonly hiddenGraceMs?: number;
}

export interface EventStream {
  readonly close: () => void;
}

// Three missed heartbeats of the server (one every 15 s).
const DEFAULT_SILENCE_TIMEOUT_MS = 45_000;
const DEFAULT_HIDDEN_GRACE_MS = 60_000;

const documentVisibility: PageVisibility = {
  isHidden: () => document.visibilityState === 'hidden',
  subscribe: (onChange) => {
    document.addEventListener('visibilitychange', onChange);
    return () => document.removeEventListener('visibilitychange', onChange);
  },
};

type Timer = ReturnType<typeof setTimeout>;

export const openEventStream = (options: EventStreamOptions): EventStream => {
  const {
    createEventSource = (url) => new EventSource(url),
    visibility = documentVisibility,
    silenceTimeoutMs = DEFAULT_SILENCE_TIMEOUT_MS,
    hiddenGraceMs = DEFAULT_HIDDEN_GRACE_MS,
  } = options;
  let source: EventSourceConnection | null = null;
  let failedAttempts = 0;
  let silenceTimer: Timer | undefined;
  let reconnectTimer: Timer | undefined;
  let hiddenTimer: Timer | undefined;

  const disconnect = (): void => {
    source?.close();
    source = null;
    clearTimeout(silenceTimer);
    clearTimeout(reconnectTimer);
  };

  const reconnectLater = (): void => {
    disconnect();
    options.onStateChange('reconnecting');
    options.onRefused();
    reconnectTimer = setTimeout(connect, options.reconnectDelay(failedAttempts));
    failedAttempts += 1;
  };

  // A proxy can keep a dead connection open without an error: silence is the only sign.
  const watchSilence = (): void => {
    clearTimeout(silenceTimer);
    silenceTimer = setTimeout(reconnectLater, silenceTimeoutMs);
  };

  function connect(): void {
    disconnect();
    options.onStateChange(failedAttempts === 0 ? 'connecting' : 'reconnecting');
    const current = createEventSource(options.url);
    source = current;
    current.addEventListener('open', () => {
      failedAttempts = 0;
      options.onStateChange('open');
      watchSilence();
    });
    current.addEventListener('error', () => {
      // CONNECTING: the browser retries on its own. CLOSED: the server answered with an error
      // status and the browser gave up for good, so reconnecting is ours to do.
      if (current.readyState === current.CLOSED) {
        reconnectLater();
      } else {
        options.onStateChange('reconnecting');
      }
    });
    for (const type of options.eventTypes) {
      current.addEventListener(type, (event) => {
        watchSilence();
        if (event instanceof MessageEvent && typeof event.data === 'string') {
          options.onEvent(type, event.data);
        }
      });
    }
    watchSilence();
  }

  const pause = (): void => {
    disconnect();
    options.onStateChange('paused');
  };

  const onVisibilityChange = (): void => {
    clearTimeout(hiddenTimer);
    if (visibility.isHidden()) {
      hiddenTimer = setTimeout(pause, hiddenGraceMs);
    } else if (source === null) {
      failedAttempts = 0;
      connect();
    }
  };

  const unsubscribeVisibility = visibility.subscribe(onVisibilityChange);
  connect();

  return {
    close: () => {
      unsubscribeVisibility();
      clearTimeout(hiddenTimer);
      disconnect();
    },
  };
};
