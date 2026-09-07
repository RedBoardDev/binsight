import { describe, expect, it } from 'vitest';
import { requireCopierOwner, requireCopierWallet } from './copier-identity';

// #24 — the coffre loads + signs with the copier wallet and asserts it against COPIER_OWNER; the brain scopes to the
// same owner. The old code silently fell back to a bench TEST wallet (`.wallets/copier-test.json` + a hardcoded owner
// pubkey), so a deploy that forgot the env would transact as the wrong wallet. These guards MUST fail-closed: no
// silent test default — a missing env is a boot error, mirroring the bus-key guard.
describe('requireCopierOwner — fail-closed COPIER_OWNER', () => {
  it('returns the owner verbatim when set', () => {
    expect(
      requireCopierOwner({ COPIER_OWNER: 'OwNeR11111111111111111111111111111111111111' }),
    ).toEqual({ owner: 'OwNeR11111111111111111111111111111111111111' });
  });

  it('★ errors when COPIER_OWNER is unset (NO silent hardcoded-owner default)', () => {
    const r = requireCopierOwner({});
    expect('error' in r).toBe(true);
    // FAIL-AGAINST-OLD: the removed default must never leak back as a value.
    expect(JSON.stringify(r)).not.toContain('Ybbt2Td4TjxwpzvuicbP9ANizBwAJzqjuRmRrvDh9zz');
  });

  it('treats an empty string as unset (fail-closed, not an empty owner)', () => {
    expect('error' in requireCopierOwner({ COPIER_OWNER: '' })).toBe(true);
  });
});

describe('requireCopierWallet — fail-closed COPIER_KEYPAIR_PATH + COPIER_OWNER', () => {
  const OWNER = 'OwNeR11111111111111111111111111111111111111';

  it('returns both when set', () => {
    expect(
      requireCopierWallet({ COPIER_KEYPAIR_PATH: '/secrets/copier.json', COPIER_OWNER: OWNER }),
    ).toEqual({ keypairPath: '/secrets/copier.json', owner: OWNER });
  });

  it('★ errors when COPIER_KEYPAIR_PATH is unset (NO silent `.wallets/copier-test.json` default)', () => {
    const r = requireCopierWallet({ COPIER_OWNER: OWNER });
    expect('error' in r).toBe(true);
    expect(JSON.stringify(r)).not.toContain('copier-test.json');
  });

  it('errors when COPIER_OWNER is unset even if the keypair path is set (both are required)', () => {
    const r = requireCopierWallet({ COPIER_KEYPAIR_PATH: '/secrets/copier.json' });
    expect('error' in r).toBe(true);
    expect(JSON.stringify(r)).not.toContain('Ybbt2Td4TjxwpzvuicbP9ANizBwAJzqjuRmRrvDh9zz');
  });

  it('errors on a fully empty env (a bare deploy cannot boot onto the bench wallet)', () => {
    expect('error' in requireCopierWallet({})).toBe(true);
  });
});
