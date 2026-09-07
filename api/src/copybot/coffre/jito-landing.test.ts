import type { Connection } from '@solana/web3.js';
import { describe, expect, it, vi } from 'vitest';
import { landViaJito } from './jito-landing';

const RAW = Buffer.from([1, 2, 3]);
const SIG = 'SignatureOfTheSignedTx';
type FetchInit = {
  method: string;
  headers: Record<string, string>;
  body: string;
  signal?: AbortSignal;
};
const okFetch = (_url: string, _init: FetchInit) =>
  Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ result: 'bundle-id' }) });

describe('jito-landing · landViaJito', () => {
  it('POSTs a single-tx sendBundle and returns the tx signature on acceptance', async () => {
    const fetchFn = vi.fn(okFetch);
    const conn = { sendRawTransaction: vi.fn() } as unknown as Connection;
    const sig = await landViaJito(conn, 'https://jito.example', RAW, SIG, fetchFn);
    expect(sig).toBe(SIG);
    expect(conn.sendRawTransaction).not.toHaveBeenCalled(); // landed via Jito, not the RPC fallback
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe('https://jito.example/api/v1/bundles');
    const body = JSON.parse(init.body);
    expect(body.method).toBe('sendBundle');
    expect(body.params[0][0]).toBe(RAW.toString('base64')); // base64 of the signed tx, in a 1-tx bundle
  });

  it('falls back to a normal RPC send when Jito returns non-2xx — the tx is NEVER dropped', async () => {
    const conn = {
      sendRawTransaction: vi.fn(() => Promise.resolve('rpc-sig')),
    } as unknown as Connection;
    const sig = await landViaJito(conn, 'https://jito.example', RAW, SIG, () =>
      Promise.resolve({ ok: false, status: 429, json: () => Promise.resolve({}) }),
    );
    expect(sig).toBe('rpc-sig');
    expect(conn.sendRawTransaction).toHaveBeenCalledOnce();
  });

  it('falls back when the bundle POST throws (network/timeout)', async () => {
    const conn = {
      sendRawTransaction: vi.fn(() => Promise.resolve('rpc-sig')),
    } as unknown as Connection;
    const sig = await landViaJito(conn, 'https://jito.example', RAW, SIG, () =>
      Promise.reject(new Error('network')),
    );
    expect(sig).toBe('rpc-sig');
    expect(conn.sendRawTransaction).toHaveBeenCalledOnce();
  });

  it('sends the bundle with an AbortSignal so a black-holed Jito engine cannot hang the lane (finding #139)', async () => {
    const fetchFn = vi.fn(okFetch);
    const conn = { sendRawTransaction: vi.fn() } as unknown as Connection;
    const sig = await landViaJito(conn, 'https://jito.example', RAW, SIG, fetchFn);
    expect(sig).toBe(SIG); // 200 → still lands via Jito by its own signature (no RPC fallback)
    expect(conn.sendRawTransaction).not.toHaveBeenCalled();
    const [, init] = fetchFn.mock.calls[0]!;
    // The #139 regression tripwire: without a submit timeout the fetch could black-hole the lane for ~300s.
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('falls back to a normal RPC send when the Jito submit times out (AbortError) — the tx is NEVER dropped', async () => {
    const conn = {
      sendRawTransaction: vi.fn(() => Promise.resolve('rpc-sig')),
    } as unknown as Connection;
    // AbortSignal.timeout(...) makes fetch reject with a DOMException named 'AbortError'; simulate that rejection.
    const timeout = Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
    const sig = await landViaJito(conn, 'https://jito.example', RAW, SIG, () =>
      Promise.reject(timeout),
    );
    expect(sig).toBe('rpc-sig'); // routed to the SAME land() fallback, not a divergent signature
    expect(conn.sendRawTransaction).toHaveBeenCalledOnce(); // exactly-once: re-broadcast the SAME signed tx
  });
});
