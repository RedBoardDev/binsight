import { Connection } from '@solana/web3.js';
import type { Logger } from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BRAIN_FAILOVER_READS,
  COFFRE_FAILOVER_READS,
  createFailoverConnection,
} from './failover-connection';

// Reads-only RPC failover (#50). These tests lock the MONEY-SAFETY contract, not just the mechanics:
// a whitelisted READ may be served by the secondary, but nothing that could double-land a transaction
// (sendRawTransaction) or fabricate a confirm verdict (getSignatureStatuses) may EVER touch the fallback.

const PRIMARY_URL = 'http://primary.invalid:8899';
const FALLBACK_URL = 'http://fallback.invalid:8899';

/**
 * Spy on a `Connection.prototype` method, recording each call's `this` so the test can tell the PRIMARY
 * instance (the factory's return value) from the internal fallback instance apart. The failover wrapper
 * resolves the prototype method at call time, so this spy sees both legs.
 */
function spyOnProto(
  name: 'getSlot' | 'sendRawTransaction' | 'getSignatureStatuses',
  impl: (self: Connection) => Promise<unknown>,
): { contexts: Connection[] } {
  const contexts: Connection[] = [];
  // Erased view of the prototype: vitest's mockImplementation cannot type a UNION of method signatures, and the
  // stub only records `this` + delegates — the erased `unknown` shape is the sound test seam (no `any`).
  const proto = Connection.prototype as unknown as Record<
    string,
    (this: Connection, ...args: unknown[]) => Promise<unknown>
  >;
  vi.spyOn(proto, name).mockImplementation(async function (this: Connection) {
    contexts.push(this);
    return await impl(this);
  });
  return { contexts };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createFailoverConnection', () => {
  it('serves a whitelisted read from the fallback when the primary throws — exactly one fallback attempt, and the degradation is logged for the operator', async () => {
    const warn = vi.fn();
    const log = { warn } as unknown as Pick<Logger, 'warn'>; // pino seam: only `warn` is used by the wrapper
    const conn = createFailoverConnection(PRIMARY_URL, FALLBACK_URL, BRAIN_FAILOVER_READS, log);
    const { contexts } = spyOnProto('getSlot', async (self) => {
      if (self === conn) throw new Error('primary 503');
      return 1234;
    });

    await expect(conn.getSlot()).resolves.toBe(1234);
    // Exactly one primary attempt + exactly one fallback attempt — never ping-pong.
    expect(contexts).toHaveLength(2);
    expect(contexts[0]).toBe(conn);
    expect(contexts[1]).not.toBe(conn);
    // An operator must be able to SEE the primary is degraded (the failover is silent otherwise).
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('never touches the fallback while the primary is healthy (the secondary is a failover, not a load-balancer)', async () => {
    const conn = createFailoverConnection(PRIMARY_URL, FALLBACK_URL, BRAIN_FAILOVER_READS);
    const { contexts } = spyOnProto('getSlot', async () => 42);

    await expect(conn.getSlot()).resolves.toBe(42);
    expect(contexts).toEqual([conn]);
  });

  it('sendRawTransaction NEVER fails over: a primary throw propagates with zero fallback calls (the anti-double-land lock)', async () => {
    const conn = createFailoverConnection(PRIMARY_URL, FALLBACK_URL, BRAIN_FAILOVER_READS);
    const { contexts } = spyOnProto('sendRawTransaction', async () => {
      throw new Error('primary send failed');
    });

    // A retried submit on a second transport could double-land the SAME transaction → it is in NO whitelist.
    expect(BRAIN_FAILOVER_READS).not.toContain('sendRawTransaction');
    expect(COFFRE_FAILOVER_READS).not.toContain('sendRawTransaction');
    await expect(conn.sendRawTransaction(Buffer.from([]))).rejects.toThrow('primary send failed');
    expect(contexts).toEqual([conn]);
  });

  it('without a fallback URL the factory returns a bare Connection and a read failure propagates (no hidden fallback)', async () => {
    const conn = createFailoverConnection(PRIMARY_URL, undefined, BRAIN_FAILOVER_READS);
    // Byte-for-byte today's single-endpoint behavior: a plain Connection, no wrapper subclass.
    expect(Object.getPrototypeOf(conn)).toBe(Connection.prototype);
    const { contexts } = spyOnProto('getSlot', async () => {
      throw new Error('primary down');
    });

    await expect(conn.getSlot()).rejects.toThrow('primary down');
    expect(contexts).toEqual([conn]);
  });

  it("passes the 'confirmed' commitment to BOTH the primary and the fallback (a failover read must answer the same question)", async () => {
    const conn = createFailoverConnection(PRIMARY_URL, FALLBACK_URL, BRAIN_FAILOVER_READS);
    const { contexts } = spyOnProto('getSlot', async (self) => {
      if (self === conn) throw new Error('primary down');
      return 7;
    });

    await conn.getSlot();
    expect(conn.commitment).toBe('confirmed');
    const fallback = contexts[1] as Connection;
    expect(fallback.commitment).toBe('confirmed');
  });

  it('getSignatureStatuses is NOT in COFFRE_FAILOVER_READS and never fails over (a lagging fallback must not fabricate a dead verdict → re-claim → re-sign)', async () => {
    expect(COFFRE_FAILOVER_READS).not.toContain('getSignatureStatuses');
    expect(COFFRE_FAILOVER_READS).not.toContain('getSignatureStatus');
    expect(COFFRE_FAILOVER_READS).not.toContain('getBlockHeight');

    const conn = createFailoverConnection(PRIMARY_URL, FALLBACK_URL, COFFRE_FAILOVER_READS);
    const { contexts } = spyOnProto('getSignatureStatuses', async () => {
      throw new Error('primary outage');
    });

    // During a primary outage the confirm-worker/recovery simply FAIL → rows stay 'submitted'/retryLater,
    // a SAFE pause — never a fallback-fabricated verdict.
    await expect(conn.getSignatureStatuses(['sig'])).rejects.toThrow('primary outage');
    expect(contexts).toEqual([conn]);
  });
});
