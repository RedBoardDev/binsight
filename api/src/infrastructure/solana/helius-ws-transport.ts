import { WebSocket } from 'undici';
import type { CreditMeter } from './credit-meter';
import { WS_BYTES_PER_CREDIT_UNIT } from './credit-meter';
import type { WsTransport, WsTransportFactory } from './transaction-stream';

/**
 * Real {@link WsTransport} over undici's WHATWG WebSocket — the ONLY place a live Helius socket is opened,
 * and ONLY when {@link WsTransportFactory} is invoked (which {@link TransactionStream.start} does at runtime,
 * Step 8). Thin + I/O-only: it just forwards the socket's open/message/close/error to the stream and writes
 * frames the stream hands it; ALL no-miss logic (cursor, dedup, replay, gap detection, reconnect) lives in
 * TransactionStream. Deliberately NOT imported by any test — constructing it opens a socket, and a stray
 * Helius connection burns credits.
 */
class HeliusWsTransport implements WsTransport {
  private readonly ws: WebSocket;

  /** Cumulative bytes received, and how many megabytes of that we have already billed. Helius charges
   *  per STARTED megabyte, so we charge on each boundary crossed rather than per message — billing each
   *  frame would cost 20 credits for a 100-byte notification. */
  private bytesReceived = 0;
  private megabytesBilled = 0;

  constructor(
    url: string,
    private readonly meter?: CreditMeter,
  ) {
    // Opening the socket happens HERE, in the constructor — so a transport instance only exists once the
    // stream's factory is invoked at connect time, never at composition/import.
    this.ws = new WebSocket(url);
  }

  onOpen(cb: () => void): void {
    this.ws.addEventListener('open', () => {
      // Opening a subscription is itself billable (1 credit); recording it here means a reconnect storm
      // shows up in the ledger instead of hiding behind the HTTP-only counters.
      this.meter?.record('wsOpen', { codePath: 'stream' });
      cb();
    });
  }

  onMessage(cb: (data: string) => void): void {
    this.ws.addEventListener('message', (ev) => {
      const data = typeof ev.data === 'string' ? ev.data : String(ev.data);
      // Streamed bytes are billed per started megabyte. Without this the WebSocket — the busiest
      // surface once the Enhanced API leaves the recurring path — would be entirely unmetered, and
      // /debug/rpc would under-report real spend with no way to notice.
      this.bill(Buffer.byteLength(data, 'utf8'));
      cb(data);
    });
  }

  /** Accumulate `bytes` and charge one `wsData` unit for each megabyte boundary this crosses. */
  private bill(bytes: number): void {
    if (!this.meter) return;
    this.bytesReceived += bytes;
    const owed = Math.ceil(this.bytesReceived / WS_BYTES_PER_CREDIT_UNIT);
    while (this.megabytesBilled < owed) {
      this.megabytesBilled++;
      this.meter.record('wsData', { codePath: 'stream' });
    }
  }

  onClose(cb: () => void): void {
    this.ws.addEventListener('close', () => cb());
  }

  onError(cb: (err: unknown) => void): void {
    this.ws.addEventListener('error', (ev) => cb(ev));
  }

  send(data: string): void {
    this.ws.send(data);
  }

  ping(): void {
    // The WHATWG WebSocket API (undici / Node's global) exposes no app-level ping frame — that is the `ws`
    // library's extension, which is not a dependency. Liveness is instead guaranteed by the protocol-level
    // server PING that undici auto-PONGs, with the stream's onClose→reconnect + gap detector as the no-miss
    // backstop if the socket ever does die silently. So this keepalive hook is intentionally a no-op.
  }

  close(): void {
    this.ws.close();
  }
}

/** Builds a fresh transport per (re)connect, bound to `url`. Invoked by TransactionStream at connect time. */
export function createHeliusWsTransportFactory(
  url: string,
  meter?: CreditMeter,
): WsTransportFactory {
  return () => new HeliusWsTransport(url, meter);
}
