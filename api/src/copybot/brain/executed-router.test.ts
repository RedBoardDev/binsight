import { describe, expect, it } from 'vitest';
import { type RoutableRuntime, resolveExecutedTarget } from './executed-router';

function rt(
  userId: string,
  over: { positions?: string[]; commands?: string[] } = {},
): RoutableRuntime {
  return {
    userId,
    ownsOurPosition: (p) => (over.positions ?? []).includes(p),
    ownsCommand: (c) => (over.commands ?? []).includes(c),
  };
}

describe('resolveExecutedTarget — ev:executed → the OWNING runtime (S5, INC3B-PLAN §3)', () => {
  it('ev.userId resolves FIRST (authoritative: the tenant that published the command)', () => {
    // WHY: two users can mirror the SAME leader position; only the publisher's tenant owns this confirm — a
    // position scan could not disambiguate a wallet-level sell, the stamped userId always can.
    const a = rt('user-a');
    const b = rt('user-b', { positions: ['OUR_POS'] });
    const runtimes = new Map([
      ['user-a', a],
      ['user-b', b],
    ]);
    expect(resolveExecutedTarget(runtimes, { userId: 'user-a', positionPubkey: 'OUR_POS' })).toBe(
      a,
    );
  });

  it('no userId (deploy-window legacy message) → position ownership resolves it', () => {
    // WHY: messages in flight across the 3b deploy predate the userId field — a close confirm among them must
    // still reach the runtime holding the mirror (a dropped close is the forbidden failure).
    const a = rt('user-a');
    const b = rt('user-b', { positions: ['OUR_POS'] });
    const runtimes = new Map([
      ['user-a', a],
      ['user-b', b],
    ]);
    expect(resolveExecutedTarget(runtimes, { positionPubkey: 'OUR_POS' })).toBe(b);
  });

  it('UNKNOWN userId falls through to ownership (a stale tenant id must not drop an owned confirm)', () => {
    const b = rt('user-b', { positions: ['OUR_POS'] });
    const runtimes = new Map([['user-b', b]]);
    expect(
      resolveExecutedTarget(runtimes, { userId: 'user-gone', positionPubkey: 'OUR_POS' }),
    ).toBe(b);
  });

  it('commandId ownership resolves a deferred continuation (disjoint across users by derivation)', () => {
    const a = rt('user-a', { commands: ['CMD_A'] });
    const b = rt('user-b', { commands: ['CMD_B'] });
    const runtimes = new Map([
      ['user-a', a],
      ['user-b', b],
    ]);
    expect(resolveExecutedTarget(runtimes, { commandId: 'CMD_B' })).toBe(b);
  });

  it('position ownership WINS over commandId (the mirror row is the stronger claim)', () => {
    const a = rt('user-a', { positions: ['OUR_POS'] });
    const b = rt('user-b', { commands: ['CMD'] });
    const runtimes = new Map([
      ['user-a', a],
      ['user-b', b],
    ]);
    expect(resolveExecutedTarget(runtimes, { positionPubkey: 'OUR_POS', commandId: 'CMD' })).toBe(
      a,
    );
  });

  it('nothing matches → undefined (the caller acks a close ONLY because the reconcile backstop covers it)', () => {
    const runtimes = new Map([['user-a', rt('user-a')]]);
    expect(
      resolveExecutedTarget(runtimes, { positionPubkey: 'X', commandId: 'Y' }),
    ).toBeUndefined();
    expect(resolveExecutedTarget(new Map(), { userId: 'user-a' })).toBeUndefined();
  });
});
