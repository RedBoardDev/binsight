import { describe, expect, it, vi } from 'vitest';
import { TtlCache } from '../../ttl-cache';
import { type DataSource, FILTERS_ALL_OFF } from '../filter';
import { neededSources, runFilters } from '../index';
import { type ResolveDeps, resolveFilterContext } from './resolve';
import type { TokenSnapshot } from './source';

const SNAP: TokenSnapshot = {
  organicScore: 70,
  holders: 500,
  marketCapUsd: 2_000_000,
  volume24hUsd: 10_000,
  priceChange24hPercent: 5,
  firstPoolCreatedAtMs: 1_000,
  mintAuthorityDisabled: true,
  freezeAuthorityDisabled: true,
  topHoldersPercent: 10,
};

const provider = (snap: TokenSnapshot | null) => vi.fn(async () => snap);
const feeProvider = (v: boolean | null) => vi.fn(async () => v);
const sources = (...s: DataSource[]) => new Set<DataSource>(s);
const newCache = () => new TtlCache<TokenSnapshot>(60_000);
const newFeeCache = () => new TtlCache<boolean>(60_000);
const ONE_HOUR_LATER = 3_600_000 + 1_000; // nowMs so age = 1h given firstPoolCreatedAtMs=1_000

/** Full ResolveDeps with inert defaults per source; override only what a test exercises (codebase `over` idiom). */
const deps = (over: Partial<ResolveDeps> = {}): ResolveDeps => ({
  jupiterToken: provider(SNAP),
  snapshotCache: newCache(),
  mintExtensions: feeProvider(null),
  transferFeeCache: newFeeCache(),
  ...over,
});

describe('resolveFilterContext — one fetch per needed source, cache-first, miss ⇒ omitted', () => {
  it('no jupiter-token source → no fetch, empty data', async () => {
    const jupiterToken = provider(SNAP);
    const data = await resolveFilterContext('MINT', sources('local'), deps({ jupiterToken }), {
      nowMs: ONE_HOUR_LATER,
      timeoutMs: 1_000,
    });
    expect(data).toEqual({});
    expect(jupiterToken).not.toHaveBeenCalled();
  });

  it('jupiter-token source → fetches once and projects the snapshot', async () => {
    const data = await resolveFilterContext(
      'MINT',
      sources('jupiter-token'),
      deps({ jupiterToken: provider(SNAP) }),
      { nowMs: ONE_HOUR_LATER, timeoutMs: 1_000 },
    );
    expect(data.organicScore).toBe(70);
    expect(data.marketCapUsd).toBe(2_000_000);
    expect(data.tokenAgeHours).toBeCloseTo(1, 6);
  });

  it('null mint → empty, no fetch', async () => {
    const jupiterToken = provider(SNAP);
    expect(
      await resolveFilterContext(null, sources('jupiter-token'), deps({ jupiterToken }), {
        nowMs: 0,
        timeoutMs: 1_000,
      }),
    ).toEqual({});
    expect(jupiterToken).not.toHaveBeenCalled();
  });

  it('provider returns null (miss) → empty data (enabled filters will skip)', async () => {
    expect(
      await resolveFilterContext(
        'MINT',
        sources('jupiter-token'),
        deps({ jupiterToken: provider(null) }),
        { nowMs: 0, timeoutMs: 1_000 },
      ),
    ).toEqual({});
  });

  it('cache-hit → the provider is NOT called again (pre-warm / batch reuse)', async () => {
    const cache = newCache();
    cache.set('MINT', SNAP, ONE_HOUR_LATER); // fresh as of the query time (within TTL)
    const jupiterToken = provider(SNAP);
    const data = await resolveFilterContext(
      'MINT',
      sources('jupiter-token'),
      deps({ jupiterToken, snapshotCache: cache }),
      { nowMs: ONE_HOUR_LATER, timeoutMs: 1_000 },
    );
    expect(jupiterToken).not.toHaveBeenCalled();
    expect(data.organicScore).toBe(70);
  });

  it('a provider that REJECTS → empty data, never throws (errors must not crash the open path)', async () => {
    // WHY: a Jupiter blip must degrade to "filter data unavailable" (→ skip), never propagate an exception up the
    // open hot path. settleWithin swallows the rejection and resolves null.
    const boom = vi.fn(async () => {
      throw new Error('jupiter 500');
    });
    const data = await resolveFilterContext(
      'MINT',
      sources('jupiter-token'),
      deps({ jupiterToken: boom }),
      {
        nowMs: 0,
        timeoutMs: 1_000,
      },
    );
    expect(data).toEqual({});
    expect(boom).toHaveBeenCalledOnce();
  });

  it('a provider that hangs → null within budget (hard timeout, off the critical path)', async () => {
    vi.useFakeTimers();
    const hang = vi.fn(() => new Promise<TokenSnapshot>(() => {}));
    const promise = resolveFilterContext(
      'MINT',
      sources('jupiter-token'),
      deps({ jupiterToken: hang }),
      {
        nowMs: 0,
        timeoutMs: 100,
      },
    );
    await vi.advanceTimersByTimeAsync(100);
    expect(await promise).toEqual({});
    vi.useRealTimers();
  });
});

describe('resolveFilterContext — mint-extensions source resolves hasTransferFee (finding #105)', () => {
  it("fee'd mint → hasTransferFee=true (enabled brick will skip the open)", async () => {
    const data = await resolveFilterContext(
      'MINT',
      sources('mint-extensions'),
      deps({ mintExtensions: feeProvider(true) }),
      { nowMs: 0, timeoutMs: 1_000 },
    );
    expect(data.hasTransferFee).toBe(true);
  });

  it('fee-free mint → hasTransferFee=false (enabled brick PASSES — no longer fail-closed)', async () => {
    const data = await resolveFilterContext(
      'MINT',
      sources('mint-extensions'),
      deps({ mintExtensions: feeProvider(false) }),
      { nowMs: 0, timeoutMs: 1_000 },
    );
    expect(data.hasTransferFee).toBe(false);
  });

  it('unreadable mint (provider null) → hasTransferFee UNRESOLVED so the brick fails closed', async () => {
    // WHY: an unreadable mint must NOT resolve to false, or a fee'd mint could slip through the two-sided haircut.
    const data = await resolveFilterContext(
      'MINT',
      sources('mint-extensions'),
      deps({ mintExtensions: feeProvider(null) }),
      { nowMs: 0, timeoutMs: 1_000 },
    );
    expect('hasTransferFee' in data).toBe(false);
  });

  it('no mint-extensions source → the provider is not called', async () => {
    const mintExtensions = feeProvider(true);
    const data = await resolveFilterContext('MINT', sources('local'), deps({ mintExtensions }), {
      nowMs: 0,
      timeoutMs: 1_000,
    });
    expect(data).toEqual({});
    expect(mintExtensions).not.toHaveBeenCalled();
  });

  it('cache-hit → the provider is NOT called again (per-mint; the extension set is immutable)', async () => {
    const cache = newFeeCache();
    cache.set('MINT', true, 0);
    const mintExtensions = feeProvider(true);
    const data = await resolveFilterContext(
      'MINT',
      sources('mint-extensions'),
      deps({ mintExtensions, transferFeeCache: cache }),
      { nowMs: 0, timeoutMs: 1_000 },
    );
    expect(mintExtensions).not.toHaveBeenCalled();
    expect(data.hasTransferFee).toBe(true);
  });

  it('a cached FALSE is preserved (a fee-free mint is not re-fetched — ?? must keep false)', async () => {
    // WHY: false is a legitimate cached answer; nullish-coalescing must not treat it as a miss and re-read.
    const cache = newFeeCache();
    cache.set('MINT', false, 0);
    const mintExtensions = feeProvider(true); // would flip to true if (wrongly) re-fetched
    const data = await resolveFilterContext(
      'MINT',
      sources('mint-extensions'),
      deps({ mintExtensions, transferFeeCache: cache }),
      { nowMs: 0, timeoutMs: 1_000 },
    );
    expect(mintExtensions).not.toHaveBeenCalled();
    expect(data.hasTransferFee).toBe(false);
  });

  it('a fresh confirmed read is cached (a second resolve does not re-call the provider)', async () => {
    const mintExtensions = feeProvider(true);
    const d = deps({ mintExtensions, transferFeeCache: newFeeCache() });
    await resolveFilterContext('MINT', sources('mint-extensions'), d, {
      nowMs: 0,
      timeoutMs: 1_000,
    });
    await resolveFilterContext('MINT', sources('mint-extensions'), d, {
      nowMs: 0,
      timeoutMs: 1_000,
    });
    expect(mintExtensions).toHaveBeenCalledOnce();
  });

  it('an UNREADABLE result is NOT cached (a later confirmed read still resolves)', async () => {
    // WHY: caching null would pin a transient RPC blip as permanent-unknown; only confirmed reads are cached.
    const mintExtensions = vi.fn().mockResolvedValueOnce(null).mockResolvedValue(true);
    const d = deps({ mintExtensions, transferFeeCache: newFeeCache() });
    const first = await resolveFilterContext('MINT', sources('mint-extensions'), d, {
      nowMs: 0,
      timeoutMs: 1_000,
    });
    const second = await resolveFilterContext('MINT', sources('mint-extensions'), d, {
      nowMs: 0,
      timeoutMs: 1_000,
    });
    expect('hasTransferFee' in first).toBe(false);
    expect(second.hasTransferFee).toBe(true);
    expect(mintExtensions).toHaveBeenCalledTimes(2);
  });

  it('both sources needed → jupiter fields AND hasTransferFee are merged', async () => {
    const data = await resolveFilterContext(
      'MINT',
      sources('jupiter-token', 'mint-extensions'),
      deps({ jupiterToken: provider(SNAP), mintExtensions: feeProvider(true) }),
      { nowMs: ONE_HOUR_LATER, timeoutMs: 1_000 },
    );
    expect(data.organicScore).toBe(70);
    expect(data.hasTransferFee).toBe(true);
  });
});

describe('mint-extensions e2e — resolveFilterContext → runFilters (finding #105 no-open decision)', () => {
  const cfg = { ...FILTERS_ALL_OFF, skipTransferFeeTokens: true };
  const decide = async (hasFee: boolean | null) => {
    const external = await resolveFilterContext(
      'MINT',
      neededSources(cfg), // proves the wiring: an enabled skipTransferFeeTokens actually requests mint-extensions
      deps({ mintExtensions: feeProvider(hasFee) }),
      { nowMs: 0, timeoutMs: 1_000 },
    );
    return runFilters(
      { nonSolMint: 'MINT', pool: 'POOL' },
      { openTokenMints: new Set(), ...external },
      cfg,
    );
  };

  it('enabled skipTransferFeeTokens routes through the mint-extensions source', () => {
    expect(neededSources(cfg).has('mint-extensions')).toBe(true);
  });

  it('fee-free mint now PASSES (the provider unblocks what used to be fail-closed)', async () => {
    expect(await decide(false)).toEqual({ action: 'pass' });
  });

  it("fee'd mint SKIPS transfer_fee_token (both-or-nothing two-sided open)", async () => {
    expect(await decide(true)).toEqual({ action: 'skip', reason: 'transfer_fee_token' });
  });

  it('unreadable mint STILL fails closed (transfer_fee_unavailable)', async () => {
    expect(await decide(null)).toEqual({ action: 'skip', reason: 'transfer_fee_unavailable' });
  });
});
