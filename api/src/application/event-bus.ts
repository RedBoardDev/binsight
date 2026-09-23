import type {
  ClosedPosition,
  Health,
  LiveEvent,
  OpenPosition,
  WalletState,
} from '@binsight/shared';

type Events = {
  state: WalletState;
  event: LiveEvent;
  // A notification the user has actually enabled (rule-gated) and that must surface as a native
  // banner on an active client. Distinct from `event` (the raw live feed, broadcast ungated).
  notify: LiveEvent;
  /** A position went open → closed since the persisted open set. */
  closed: ClosedPosition;
  /** A position appeared in the open set (a live open, not the first projection of a wallet). */
  opened: OpenPosition;
  /** An open position crossed its range boundary. */
  rangeChanged: { position: OpenPosition; outOfRange: boolean };
  // Fired the instant a position's close is persisted (before the settled-value notification),
  // so clients can refetch the closed-history list and show it without waiting for the alert.
  closedChanged: { wallet: string };
  health: Health;
};

type Handler<T> = (payload: T) => void;

/** Tiny typed in-process pub/sub. The HTTP/WS layer and the notification manager subscribe. */
export class EventBus {
  private readonly handlers: { [K in keyof Events]: Set<Handler<Events[K]>> } = {
    state: new Set(),
    event: new Set(),
    notify: new Set(),
    closed: new Set(),
    opened: new Set(),
    rangeChanged: new Set(),
    closedChanged: new Set(),
    health: new Set(),
  };

  on<K extends keyof Events>(type: K, handler: Handler<Events[K]>): () => void {
    this.handlers[type].add(handler);
    return () => this.handlers[type].delete(handler);
  }

  emit<K extends keyof Events>(type: K, payload: Events[K]): void {
    for (const h of this.handlers[type]) {
      try {
        h(payload);
      } catch {
        /* a subscriber must never break the emitter */
      }
    }
  }
}
