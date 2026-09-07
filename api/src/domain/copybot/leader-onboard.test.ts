import { describe, expect, it } from 'vitest';
import { CONFIG_DEFAULTS, DEFAULT_LEADER_ADDRESS } from './config';
import { applyNewLeaderConfig, leaderRejectReason, type NewLeaderInput } from './leader-onboard';

// A real, valid base58 Solana address (32-byte) not equal to the default leader.
const GOOD = '5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1';
const OWN = 'Ybbt2Td4TjxwpzvuicbP9ANizBwAJzqjuRmRrvDh9zz';

describe('leaderRejectReason', () => {
  it('accepts a valid, new, non-own address', () => {
    expect(
      leaderRejectReason({ address: GOOD, ownAddress: OWN, existingAddresses: [] }),
    ).toBeNull();
  });

  it('rejects a malformed address', () => {
    expect(
      leaderRejectReason({ address: 'not-base58!', ownAddress: OWN, existingAddresses: [] }),
    ).toBe('invalid_address');
  });

  it('rejects the user OWN bot wallet (a self-copy loop)', () => {
    expect(leaderRejectReason({ address: OWN, ownAddress: OWN, existingAddresses: [] })).toBe(
      'own_wallet',
    );
  });

  it('rejects a leader already configured (a duplicate mirror)', () => {
    expect(leaderRejectReason({ address: GOOD, ownAddress: OWN, existingAddresses: [GOOD] })).toBe(
      'duplicate',
    );
  });

  it('own-wallet takes precedence over duplicate (both would reject; the more specific reason wins)', () => {
    expect(leaderRejectReason({ address: OWN, ownAddress: OWN, existingAddresses: [OWN] })).toBe(
      'own_wallet',
    );
  });
});

describe('applyNewLeaderConfig', () => {
  const input: NewLeaderInput = {
    address: GOOD,
    maxTradeSizeSol: 2,
    tradeRatioPct: 150,
    maxTotalExposureSol: 10,
    twoSidedMode: 'on',
  };

  it('appends the leader STOPPED with the wizard-configured overrides', () => {
    const next = applyNewLeaderConfig(CONFIG_DEFAULTS, input);
    const added = next.leaders.find((l) => l.address === GOOD);
    expect(added).toBeDefined();
    // WHY: a just-added leader must NEVER copy before the user presses Start (SPEC §4.3).
    expect(added?.enabled).toBe(false);
    expect(added?.maxTotalExposureSol).toBe(10);
    expect(added?.overrides.sizing?.maxTradeSizeSol).toBe(2);
    expect(added?.overrides.sizing?.tradeRatioPct).toBe(150); // >100% amplify is preserved
    expect(added?.overrides.twoSidedMode).toBe('on');
  });

  it('keeps the existing leaders untouched', () => {
    const next = applyNewLeaderConfig(CONFIG_DEFAULTS, input);
    expect(next.leaders.some((l) => l.address === DEFAULT_LEADER_ADDRESS)).toBe(true);
    expect(next.leaders).toHaveLength(CONFIG_DEFAULTS.leaders.length + 1);
  });

  it('throws on a duplicate (the deterministic guard the service re-checks)', () => {
    expect(() =>
      applyNewLeaderConfig(CONFIG_DEFAULTS, { ...input, address: DEFAULT_LEADER_ADDRESS }),
    ).toThrow();
  });
});
