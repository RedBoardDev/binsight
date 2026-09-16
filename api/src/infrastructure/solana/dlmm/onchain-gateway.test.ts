import { TOKEN_PROGRAM_ID } from '@binsight/shared';
import { type Connection, PublicKey } from '@solana/web3.js';
import { describe, expect, it, vi } from 'vitest';
import type { SnapshotPlan } from '@/domain/dlmm';
import type { RawRpc } from './gpa-v2';
import { OnchainDlmmGateway } from './onchain-gateway';

const OWNER = 'So11111111111111111111111111111111111111112';
const TOKEN_PROGRAM = new PublicKey(TOKEN_PROGRAM_ID);

/** getMultipleAccounts stubs (empty/null infos) — enough to exercise the discovery-gating path. */
class FakeConn {
  async getMultipleAccountsInfoAndContext(keys: unknown[]) {
    return { context: { slot: 100 }, value: keys.map(() => null) };
  }
  async getMultipleAccountsInfo(keys: unknown[]) {
    return keys.map(() => null);
  }
}

/** Raw-RPC spy: records discovery methods and returns one empty final page for each V2 shape. */
function fakeRawRpc(): RawRpc & { calls: { method: string; params: unknown[] }[] } {
  const calls: { method: string; params: unknown[] }[] = [];
  const fn = vi.fn(async (method: string, params: unknown[]) => {
    calls.push({ method, params });
    // The owner-indexed endpoint answers with `value`; getProgramAccountsV2 with `accounts`.
    if (method === 'getTokenAccountsByOwnerV2') {
      return { result: { value: [], paginationKey: null } };
    }
    return { result: { accounts: [], paginationKey: null } };
  }) as unknown as RawRpc & { calls: typeof calls };
  fn.calls = calls;
  return fn;
}

describe('OnchainDlmmGateway — Layer A discovery gating', () => {
  it('discovers via getProgramAccountsV2, and skips it when a cached plan is reused', async () => {
    const conn = new FakeConn();
    const raw = fakeRawRpc();
    const g = new OnchainDlmmGateway(conn as unknown as Connection, raw);

    const fresh = await g.snapshotWallet(OWNER);
    // Positions via the 1-credit V2 method, then BOTH token programs through the owner-indexed
    // endpoint — the wallet's whole token inventory, not a hardcoded stablecoin shortlist.
    expect(raw.calls.map((call) => call.method)).toEqual([
      'getProgramAccountsV2',
      'getTokenAccountsByOwnerV2',
      'getTokenAccountsByOwnerV2',
    ]);
    expect(fresh.complete).toBe(true); // no positions → nothing could be under-counted

    const reused = await g.snapshotWallet(OWNER, fresh.plan);
    expect(raw.calls).toHaveLength(3); // discovery SKIPPED — no extra call on the cached-plan path

    expect(reused.positions).toEqual(fresh.positions);
    expect(reused.nativeLamports).toBe(fresh.nativeLamports);
    expect(reused.idleTokens).toEqual(fresh.idleTokens);
  });

  it('re-discovers positions + both token programs every time when no plan is passed', async () => {
    const conn = new FakeConn();
    const raw = fakeRawRpc();
    const g = new OnchainDlmmGateway(conn as unknown as Connection, raw);
    await g.snapshotWallet(OWNER);
    await g.snapshotWallet(OWNER);
    expect(raw.calls.map((call) => call.method)).toEqual([
      'getProgramAccountsV2',
      'getTokenAccountsByOwnerV2',
      'getTokenAccountsByOwnerV2',
      'getProgramAccountsV2',
      'getTokenAccountsByOwnerV2',
      'getTokenAccountsByOwnerV2',
    ]);
  });

  it('retries a lagging RPC backend without lowering the monotonic context floor', async () => {
    // A load-balanced node can answer from BEHIND the floor set by the previous chunk (Helius -32016).
    // That used to throw and abort the whole snapshot; it must retry the same floor instead.
    const calls: (number | undefined)[] = [];
    let call = 0;
    const conn = {
      async getMultipleAccountsInfoAndContext(
        keys: unknown[],
        config: { minContextSlot?: number },
      ) {
        calls.push(config.minContextSlot);
        call++;
        if (call === 2)
          throw Object.assign(new Error('Minimum context slot not reached'), { code: -32016 });
        const slot = call === 1 ? 100 : 101;
        return { context: { slot }, value: keys.map(() => null) };
      },
      async getMultipleAccountsInfo(keys: unknown[]) {
        return keys.map(() => null);
      },
    } as unknown as Connection;
    const plan: SnapshotPlan = {
      positionKeys: [],
      lbPairByPos: new Map(),
      coverageByPos: new Map(),
      lbPairKeys: [],
      binArrayKeys: [],
      binArrayMeta: [],
      // 101 keys + the owner = two chunks, so the second one carries a floor from the first.
      tokenAccountKeys: Array.from({ length: 101 }, () => PublicKey.unique()),
    };

    const snapshot = await new OnchainDlmmGateway(conn).snapshotWallet(OWNER, plan);

    // undefined (first chunk) → 100 (second chunk) → 100 (the -32016 retry, SAME floor) → 101
    // (main's existing re-converge, because the chunk landed at 101 rather than the requested 100).
    expect(calls).toEqual([undefined, 100, 100, 101]);
    expect(snapshot.slot).toBe(101);
    expect(snapshot.slotSkew).toBe(1);
  });
});

describe('OnchainDlmmGateway — decimals cache', () => {
  it('does not poison decimals at 0 on a transient RPC null, and heals on retry', async () => {
    const data = new Uint8Array(82); // SPL Mint layout — decimals byte @ offset 44
    data[44] = 6;
    let calls = 0;
    const conn = {
      async getMultipleAccountsInfo() {
        calls++;
        // first call: transient miss; then the real mint, owned by the Token program
        return calls === 1 ? [null] : [{ data, owner: TOKEN_PROGRAM }];
      },
    } as unknown as Connection;
    const g = new OnchainDlmmGateway(conn);

    // A transient null falls back to 0 for THIS call but must NOT be cached…
    expect(await g.decimalsOf(OWNER)).toBe(0);
    // …so the retry hits the RPC again and heals to the real decimals (would stay 0 if 0 were cached).
    expect(await g.decimalsOf(OWNER)).toBe(6);
    expect(calls).toBe(2); // both reached the RPC — proves the null was never cached
    // Now the real value is cached: a third read serves from memory, no extra RPC.
    expect(await g.decimalsOf(OWNER)).toBe(6);
    expect(calls).toBe(2);
  });

  it('decimalsOfMany batches the fetch — ≤100 mints per getMultipleAccounts, NOT one RPC per mint', async () => {
    // WHY (regression): the realized-PnL pass needs every traded mint's decimals; fetching them one-by-one
    // cost ~1 getMultipleAccounts × ~1600 mints on a cold wallet — the residual spend the live validation
    // caught. Batched by 100, a cold pass is ceil(mints/100) calls and a warm one is 0.
    const data = new Uint8Array(82);
    data[44] = 6; // SPL Mint decimals @ offset 44
    let calls = 0;
    const conn = {
      async getMultipleAccountsInfo(keys: unknown[]) {
        calls++;
        return (keys as unknown[]).map(() => ({ data, owner: TOKEN_PROGRAM }));
      },
    } as unknown as Connection;
    const g = new OnchainDlmmGateway(conn);
    const mints = Array.from({ length: 250 }, () => PublicKey.unique().toBase58());

    const out = await g.decimalsOfMany(mints);

    expect(calls).toBe(3); // 250 mints / 100 per chunk = 3 calls, NOT 250
    expect(out.size).toBe(250);
    expect(out.get(mints[0]!)).toBe(6);
  });
});
