import { scopeSearchSchema } from '@app/applications/Shared/Scope/Domain/scopeSearch';
import { describe, expect, it } from 'vitest';

const ADDRESS = 'So11111111111111111111111111111111111111112';

describe('scopeSearchSchema', () => {
  it('shows every wallet over a month by default', () => {
    expect(scopeSearchSchema.parse({})).toEqual({ wallet: 'all', period: '1m' });
  });

  it('keeps a wallet address and a period of the API', () => {
    expect(scopeSearchSchema.parse({ wallet: ADDRESS, period: '3m' })).toEqual({
      wallet: ADDRESS,
      period: '3m',
    });
  });

  it('falls back to the default for a damaged value', () => {
    expect(scopeSearchSchema.parse({ wallet: 'not an address', period: '2w' })).toEqual({
      wallet: 'all',
      period: '1m',
    });
    expect(scopeSearchSchema.parse({ wallet: 42, period: null })).toEqual({
      wallet: 'all',
      period: '1m',
    });
  });
});
