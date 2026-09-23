import { SOL_MINT } from '@binsight/solana-core';
import { pino } from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JupiterPriceGateway } from './jupiter-price';

describe('JupiterPriceGateway', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('keeps each v3 request at 50 total ids including the appended SOL quote', async () => {
    const requested: string[][] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url = new URL(String(input));
        const ids = url.searchParams.get('ids')?.split(',') ?? [];
        requested.push(ids);
        const body = Object.fromEntries(
          ids.map((mint) => [mint, { usdPrice: mint === SOL_MINT ? 100 : 1 }]),
        );
        return new Response(JSON.stringify(body), { status: 200 });
      }),
    );
    const mints = Array.from({ length: 50 }, (_, index) => `mint-${index}`);

    const prices = await new JupiterPriceGateway(
      pino({ level: 'silent' }),
      'https://price.test/v3',
    ).getPricesSol(mints);

    expect(requested.map((ids) => ids.length)).toEqual([50, 2]);
    expect(requested.every((ids) => ids.includes(SOL_MINT))).toBe(true);
    expect(prices.size).toBe(50);
    expect(prices.get('mint-0')).toBe(0.01);
  });
});
