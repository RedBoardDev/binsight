import { describe, expect, it } from 'vitest';
import { createPendingOpenReservations } from './pending-open-reservations';

const TTL = 90_000;

describe('PendingOpenReservations — TTL-bounded duplicate-open reservation', () => {
  it('reserve → isPending true; clear → isPending false', () => {
    const now = 1_000;
    const r = createPendingOpenReservations(TTL, () => now);
    expect(r.isPending('P')).toBe(false);
    r.reserve('P');
    expect(r.isPending('P')).toBe(true); // open in flight → a follow-up add is treated as tracked (no 2nd open)
    r.clear('P');
    expect(r.isPending('P')).toBe(false); // registry.open ran → reservation lifted
  });

  it('a stale reservation self-heals after the TTL (isPending false and the entry is dropped)', () => {
    let now = 0;
    const r = createPendingOpenReservations(TTL, () => now);
    r.reserve('P');
    now = TTL - 1;
    expect(r.isPending('P')).toBe(true); // still within the multi-tx open window
    expect(r.size()).toBe(1);
    now = TTL; // >= TTL → stale
    expect(r.isPending('P')).toBe(false); // self-heal: a leaked reservation never blocks re-open beyond the TTL
    expect(r.size()).toBe(0); // lazily deleted
  });

  it('reservations are per-position (one position pending never suppresses another)', () => {
    const now = 5;
    const r = createPendingOpenReservations(TTL, () => now);
    r.reserve('A');
    expect(r.isPending('A')).toBe(true);
    expect(r.isPending('B')).toBe(false);
  });

  it('re-reserving refreshes the timestamp (extends the window)', () => {
    let now = 0;
    const r = createPendingOpenReservations(TTL, () => now);
    r.reserve('P');
    now = TTL - 1;
    r.reserve('P'); // refresh at TTL-1
    now = TTL; // only 1ms past the refresh → still live
    expect(r.isPending('P')).toBe(true);
    now = TTL - 1 + TTL;
    expect(r.isPending('P')).toBe(false);
  });
});

// A1-01/A1-02: `capsState` folds caps-GATED in-flight opens (those given `meta`) into the wallet-level totals so a
// burst of concurrent leader opens can't each pass their cap check against the same stale registry-only snapshot and
// breach every cap N-fold. These tests would FAIL if `activeOpens` stopped reporting an in-flight open (re-opening
// the breach) or started reporting a pre-gate / self / stale one (over-blocking a legitimate open = a missed copy).
describe('PendingOpenReservations — activeOpens (caps-gated in-flight opens folded by capsState)', () => {
  const meta = (over: Partial<{ leader: string; mint: string | null; sizeSol: number }> = {}) => ({
    leader: 'L1',
    mint: 'M1',
    sizeSol: 1,
    ...over,
  });

  it('a dispatch-time reservation WITHOUT meta (not yet caps-gated) is NOT counted', () => {
    const now = 1_000;
    const r = createPendingOpenReservations(TTL, () => now);
    r.reserve('P'); // reserved for duplicate-detection, but has not passed its caps gate yet
    expect(r.isPending('P')).toBe(true);
    expect(r.activeOpens()).toEqual([]); // capsState must NOT count an open that hasn't cleared its own gate
  });

  it('a caps-gated reservation (with meta) IS counted with its sizing/scoping', () => {
    const now = 1_000;
    const r = createPendingOpenReservations(TTL, () => now);
    r.reserve('P', meta({ leader: 'LX', mint: 'MX', sizeSol: 2.5 }));
    expect(r.activeOpens()).toEqual([{ leader: 'LX', mint: 'MX', sizeSol: 2.5 }]);
  });

  it('excludes the candidate’s OWN position (exceptPos) so a self-check never counts itself', () => {
    const now = 1_000;
    const r = createPendingOpenReservations(TTL, () => now);
    r.reserve('SELF', meta());
    r.reserve('OTHER', meta({ leader: 'L2' }));
    expect(r.activeOpens('SELF')).toEqual([{ leader: 'L2', mint: 'M1', sizeSol: 1 }]);
  });

  it('a continuation hop re-reserving WITHOUT meta PRESERVES the meta and refreshes the TTL', () => {
    let now = 0;
    const r = createPendingOpenReservations(TTL, () => now);
    r.reserve('P', meta({ sizeSol: 3 })); // caps gate stamps the meta
    now = TTL - 1;
    r.reserve('P'); // buy-landed continuation hop: no meta, just refresh
    expect(r.activeOpens()).toEqual([{ leader: 'L1', mint: 'M1', sizeSol: 3 }]); // meta survived
    now = TTL; // 1ms past the refresh → still live because the hop refreshed the timestamp
    expect(r.activeOpens()).toEqual([{ leader: 'L1', mint: 'M1', sizeSol: 3 }]);
  });

  it('a stale (past-TTL) reservation is not counted (a leaked slot self-heals, never over-blocks forever)', () => {
    let now = 0;
    const r = createPendingOpenReservations(TTL, () => now);
    r.reserve('P', meta());
    now = TTL; // >= TTL → stale
    expect(r.activeOpens()).toEqual([]);
  });

  it('the race: two caps-gated opens in flight are BOTH counted (capsState would add them to the registry snapshot)', () => {
    const now = 1_000;
    const r = createPendingOpenReservations(TTL, () => now);
    r.reserve('A', meta({ mint: 'M1', sizeSol: 1 }));
    r.reserve('B', meta({ mint: 'M1', sizeSol: 2 }));
    const pending = r.activeOpens();
    expect(pending).toHaveLength(2); // e.g. registry says 7 open → capsState reports 7+2=9 ≥ maxOpenPositions 8 → 3rd concurrent open BLOCKS
    expect(pending.filter((p) => p.mint === 'M1')).toHaveLength(2); // per-token=1 → the 2nd same-mint open BLOCKS
    expect(pending.reduce((s, p) => s + p.sizeSol, 0)).toBe(3); // combined exposure counted against maxTotalExposureSol
  });
});
