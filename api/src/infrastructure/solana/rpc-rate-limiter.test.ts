import { describe, expect, it } from 'vitest';
import { CreditMeter } from './credit-meter';
import { rpcBatchSizeOf, rpcMethodOf, SolanaRpcRateLimiter, Spacer } from './rpc-rate-limiter';

describe('Spacer', () => {
  it('spaces reservations by 1000/rps with a frozen clock', () => {
    const s = new Spacer(10, () => 1000); // 100ms spacing
    expect(s.reserve()).toBe(1000);
    expect(s.reserve()).toBe(1100);
    expect(s.reserve()).toBe(1200);
  });

  it('never reserves in the past after an idle gap (no burst credit)', () => {
    let now = 1000;
    const s = new Spacer(10, () => now);
    expect(s.reserve()).toBe(1000);
    now = 5000; // long idle — the next slot is `now`, not lastAt+spacing
    expect(s.reserve()).toBe(5000);
  });
});

describe('rpcMethodOf', () => {
  it('reads the method from a JSON-RPC body', () => {
    expect(
      rpcMethodOf(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getProgramAccounts' })),
    ).toBe('getProgramAccounts');
  });

  it('reads the first method of a batch', () => {
    expect(
      rpcMethodOf(JSON.stringify([{ method: 'getParsedTransaction' }, { method: 'getBalance' }])),
    ).toBe('getParsedTransaction');
  });

  it('returns undefined for non-string or unparseable bodies', () => {
    expect(rpcMethodOf(undefined)).toBeUndefined();
    expect(rpcMethodOf('not json')).toBeUndefined();
    expect(rpcMethodOf(JSON.stringify({ id: 1 }))).toBeUndefined();
  });
});

describe('rpcBatchSizeOf', () => {
  it('counts the entries of a batch, not the request', () => {
    expect(
      rpcBatchSizeOf(JSON.stringify([{ method: 'getTransaction' }, { method: 'getBalance' }])),
    ).toBe(2);
  });

  it('counts a single call as 1', () => {
    expect(rpcBatchSizeOf(JSON.stringify({ method: 'getBalance' }))).toBe(1);
  });

  it('falls back to 1 on unparseable or non-string bodies (never 0 — that would skip the gate)', () => {
    expect(rpcBatchSizeOf(undefined)).toBe(1);
    expect(rpcBatchSizeOf('not json')).toBe(1);
    expect(rpcBatchSizeOf(JSON.stringify([]))).toBe(1);
  });
});

describe('SolanaRpcRateLimiter', () => {
  const limits = { rps: 10, gpaRps: 5, dasRps: 2, sendRps: 1 };

  it('charges a batch for EVERY call it carries, not once for the request', () => {
    // WHY: a batch is one HTTP request but N billable calls, and the provider rate-limits it as N.
    // Reserving a single slot for 50 of them is what let the ingest blow past a 10 rps ceiling and
    // trigger a permanent 429 retry storm, while the credit meter under-reported the spend ~50-fold.
    const lim = new SolanaRpcRateLimiter(limits, () => 1000);
    expect(lim.reserveSlot('getTransaction', 5)).toBe(1400); // 5 calls × 100ms spacing, minus the first
    expect(lim.stats().total).toBe(5);
    expect(lim.stats().byMethod.getTransaction).toBe(5);
  });

  it('bills a batch as N credits on the meter', () => {
    const meter = new CreditMeter(() => 1000);
    const lim = new SolanaRpcRateLimiter(limits, () => 1000, meter);
    lim.reserveSlot('getTransaction', 25);
    expect(meter.stats().totalCalls).toBe(25);
    expect(meter.stats().totalCredits).toBe(25); // getTransaction = 1 credit each
  });

  it('treats an absent or zero weight as a single call', () => {
    const lim = new SolanaRpcRateLimiter(limits, () => 1000);
    lim.reserveSlot('getBalance');
    lim.reserveSlot('getBalance', 0);
    expect(lim.stats().total).toBe(2);
  });

  it('applies the tighter method sub-limit: getProgramAccounts pays 5/s, not the overall 10/s', () => {
    const lim = new SolanaRpcRateLimiter(limits, () => 1000);
    expect(lim.reserveSlot('getProgramAccounts')).toBe(1000);
    // 2nd gPA waits 200ms (5/s) — the method bucket dominates the 100ms overall slot.
    expect(lim.reserveSlot('getProgramAccounts')).toBe(1200);
  });

  it('an unconstrained method only pays the overall 10/s', () => {
    const lim = new SolanaRpcRateLimiter(limits, () => 0);
    expect(lim.reserveSlot('getParsedTransaction')).toBe(100);
    expect(lim.reserveSlot('getParsedTransaction')).toBe(200);
  });

  it('keeps overall spacing across mixed methods — no coincident fire after a sub-limit wait', () => {
    const lim = new SolanaRpcRateLimiter(limits, () => 1000);
    expect(lim.reserveSlot('getProgramAccounts')).toBe(1000);
    expect(lim.reserveSlot('getProgramAccounts')).toBe(1200); // gPA pushed to 1200
    // A regular call must fire AFTER the last real fire (1200), not collide at 1200.
    expect(lim.reserveSlot('getBalance')).toBe(1300);
  });

  it('meters getProgramAccountsV2 at 1 credit (10× cheaper than the legacy getProgramAccounts)', () => {
    // WHY: discover() issues getProgramAccountsV2 as a RAW JSON-RPC call through this same limiter, so the
    // CreditMeter must see the exact method name and bill it at 1 credit — that's the whole point of the
    // V2 swap (legacy getProgramAccounts is 10). reserveSlot is the choke the middleware funnels through.
    const meter = new CreditMeter(() => 0);
    const lim = new SolanaRpcRateLimiter(
      { rps: 10, gpaRps: 5, dasRps: 2, sendRps: 1 },
      () => 0,
      meter,
    );

    lim.reserveSlot('getProgramAccountsV2');
    lim.reserveSlot('getProgramAccounts'); // the legacy 10-credit method, for contrast

    const s = meter.stats();
    expect(s.byMethod.getProgramAccountsV2).toBe(1);
    expect(s.byMethod.getProgramAccounts).toBe(10);
    expect(s.totalCredits).toBe(11);
  });

  it('stats() breaks calls down by exact method — telemetry to find the credit-heavy call', () => {
    const lim = new SolanaRpcRateLimiter(limits, () => 0);
    lim.reserveSlot('getParsedTransaction');
    lim.reserveSlot('getParsedTransaction');
    lim.reserveSlot('getMultipleAccounts');
    lim.reserveSlot('getProgramAccounts');
    lim.reserveSlot(undefined);
    const s = lim.stats();
    expect(s.total).toBe(5);
    expect(s.byMethod).toEqual({
      getParsedTransaction: 2,
      getMultipleAccounts: 1,
      getProgramAccounts: 1,
      unknown: 1,
    });
    expect(s.gpa).toBe(1); // coarse class buckets still tracked alongside the per-method split
  });
});
