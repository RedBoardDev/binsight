import { describe, expect, it } from 'vitest';
import type { DetectedEvent } from './events';
import { LeaderPositionTracker } from './leader-position';

// Detected-event constructor (the tracker operates on DetectedEvent, not raw tx → readable fixtures).
function ev(p: {
  sig: string;
  instr: string;
  deposit?: number;
  withdraw?: number;
  claim?: number;
  position?: string;
  pool?: string;
  mint?: string | null;
  symbol?: string | null;
  blockTime?: number;
  closed?: boolean;
}): DetectedEvent {
  return {
    signature: p.sig,
    blockTime: p.blockTime ?? 1000,
    instruction: p.instr,
    depositSol: p.deposit ?? 0,
    withdrawSol: p.withdraw ?? 0,
    claimSol: p.claim ?? 0,
    closed: p.closed ?? false,
    pool: p.pool ?? 'POOL',
    position: p.position ?? 'POS',
    nonSolMint: p.mint === undefined ? 'MINT' : p.mint,
    nonSolSymbol: p.symbol ?? null,
  };
}

describe('LeaderPositionTracker — per-position lifecycle aggregation', () => {
  it('OPEN (1st capital-bearing event) → opens, openSize = deposit, openedAt set', () => {
    const t = new LeaderPositionTracker();
    // capital-open via AddLiquidity (handles the InitializePosition→AddLiquidity split: openSize = 1st deposit,
    // whatever the instruction class).
    const p = t.apply(
      ev({ sig: '1', instr: 'AddLiquidityByStrategy2', deposit: 5, blockTime: 1000 }),
    );
    expect(p).toMatchObject({
      status: 'open',
      openSizeSol: 5,
      openSizeKnown: true,
      depositedSol: 5,
      netSizeSol: 5,
      openedAt: 1000,
    });
  });

  it('OPEN then ADD → depositedSol grows but openSize stays the 1st deposit (stable sizing input)', () => {
    const t = new LeaderPositionTracker();
    t.apply(ev({ sig: '1', instr: 'AddLiquidityByStrategy2', deposit: 5 }));
    const p = t.apply(ev({ sig: '2', instr: 'AddLiquidityByStrategy2', deposit: 3 }));
    // WHY: the sizing input = the OPEN size, not the current size; an add must not rewrite it.
    expect(p).toMatchObject({ openSizeSol: 5, depositedSol: 8, netSizeSol: 8, status: 'open' });
  });

  it('PARTIAL withdrawal → the position stays OPEN (a partial is not a close)', () => {
    const t = new LeaderPositionTracker();
    t.apply(ev({ sig: '1', instr: 'AddLiquidityByStrategy2', deposit: 5 }));
    const p = t.apply(ev({ sig: '2', instr: 'RemoveLiquidityByRange2', withdraw: 2 }));
    // WHY: pillar — mistaking a partial for a close would make us think the leader has exited.
    expect(p).toMatchObject({ status: 'open', withdrawnSol: 2, netSizeSol: 3 });
    expect(t.openPositions()).toHaveLength(1);
  });

  it('CLOSE → status closed + closedAt, withdrawal and fees counted', () => {
    const t = new LeaderPositionTracker();
    t.apply(ev({ sig: '1', instr: 'AddLiquidityByStrategy2', deposit: 5 }));
    const p = t.apply(
      ev({ sig: '2', instr: 'ClosePosition2', withdraw: 4, claim: 0.5, blockTime: 2000 }),
    );
    // WHY: the close is the mirror-close trigger; it must mark the position closed unambiguously.
    expect(p?.status).toBe('closed');
    expect(p?.closedAt).toBe(2000);
    expect(p?.withdrawnSol).toBeCloseTo(4, 9);
    expect(p?.claimedSol).toBeCloseTo(0.5, 9);
    expect(t.openPositions()).toHaveLength(0);
  });

  it('CLAIM → claimedSol grows, but neither status nor netSize change (fees are not capital)', () => {
    const t = new LeaderPositionTracker();
    t.apply(ev({ sig: '1', instr: 'AddLiquidityByStrategy2', deposit: 5 }));
    const p = t.apply(ev({ sig: '2', instr: 'ClaimFee2', claim: 0.3 }));
    expect(p).toMatchObject({ status: 'open', netSizeSol: 5 });
    expect(p?.claimedSol).toBeCloseTo(0.3, 9);
  });

  it('cold start: a withdrawal for a position whose open was never seen → created, openSizeKnown=false', () => {
    const t = new LeaderPositionTracker();
    // WHY: the cold replay only sees the last 25 sigs → we often join mid-life; we must
    // never crash or mis-key, and we flag that the fraction base is unknown (OQ #3).
    const p = t.apply(ev({ sig: '1', instr: 'RemoveLiquidityByRange2', withdraw: 2 }));
    expect(p).toMatchObject({
      status: 'open',
      openSizeKnown: false,
      openSizeSol: 0,
      withdrawnSol: 2,
      netSizeSol: -2,
    });
  });

  it('CLOSE for an unknown position → created then closed (we never miss a close, even joined mid-life)', () => {
    const t = new LeaderPositionTracker();
    const p = t.apply(ev({ sig: '1', instr: 'ClosePosition2', withdraw: 3 }));
    expect(p).toMatchObject({ status: 'closed', openSizeKnown: false });
  });

  it('idempotent per (signature, position): re-applying the same event does not double-count', () => {
    const t = new LeaderPositionTracker();
    t.apply(ev({ sig: '1', instr: 'AddLiquidityByStrategy2', deposit: 5 }));
    t.apply(ev({ sig: '1', instr: 'AddLiquidityByStrategy2', deposit: 5 })); // duplicate (replay/live overlap)
    expect(t.get('POS')).toMatchObject({ depositedSol: 5, eventCount: 1 });
  });

  it('finding #37: TWO distinct positions in the SAME signature EACH apply (no per-signature collapse)', () => {
    // A leader tx that closes A and opens B carries two DetectedEvents under ONE signature. A per-signature
    // dedup would let only the first apply and DROP the second — silently missing B's open (or, reversed, A's
    // close, the cardinal sin). The dedup is per (signature, position), so both project into their own state.
    const t = new LeaderPositionTracker();
    const a = t.apply(ev({ sig: 'sig1', instr: 'ClosePosition2', withdraw: 3, position: 'A' }));
    const b = t.apply(
      ev({ sig: 'sig1', instr: 'AddLiquidityByStrategy2', deposit: 4, position: 'B' }),
    );
    expect(a).toMatchObject({ status: 'closed', withdrawnSol: 3 }); // A's close is NOT swallowed
    expect(b).toMatchObject({ status: 'open', depositedSol: 4, openSizeKnown: true }); // B's open applied too
    expect(t.all()).toHaveLength(2);

    // …and it stays idempotent PER position: re-observing the same (sig, position) via WS+poll overlap is a no-op.
    t.apply(ev({ sig: 'sig1', instr: 'ClosePosition2', withdraw: 3, position: 'A' }));
    t.apply(ev({ sig: 'sig1', instr: 'AddLiquidityByStrategy2', deposit: 4, position: 'B' }));
    expect(t.get('A')).toMatchObject({ withdrawnSol: 3, eventCount: 1 });
    expect(t.get('B')).toMatchObject({ depositedSol: 4, eventCount: 1 });
  });

  it('positions independent per pubkey; openPositions() returns only the open ones', () => {
    const t = new LeaderPositionTracker();
    t.apply(ev({ sig: '1', instr: 'AddLiquidityByStrategy2', deposit: 5, position: 'A' }));
    t.apply(ev({ sig: '2', instr: 'AddLiquidityByStrategy2', deposit: 4, position: 'B' }));
    t.apply(ev({ sig: '3', instr: 'ClosePosition2', withdraw: 4, position: 'B' }));
    expect(t.openPositions().map((p) => p.position)).toEqual(['A']);
    expect(t.all()).toHaveLength(2);
  });

  it('metadata: the last non-empty value wins; an empty field does not overwrite a known one', () => {
    const t = new LeaderPositionTracker();
    t.apply(ev({ sig: '1', instr: 'AddLiquidityByStrategy2', deposit: 5, symbol: null })); // mint known, symbol unknown
    // a later event brings the symbol; a null mint must NOT erase the already-known mint.
    const p = t.apply(ev({ sig: '2', instr: 'ClaimFee2', claim: 0.1, symbol: 'TOK', mint: null }));
    expect(p?.nonSolSymbol).toBe('TOK'); // symbol filled in after the fact
    expect(p?.nonSolMint).toBe('MINT'); // known mint preserved (null does not overwrite)
  });

  it('a 2nd close event (position already closed) does not rewrite status/closedAt', () => {
    const t = new LeaderPositionTracker();
    t.apply(ev({ sig: '1', instr: 'AddLiquidityByStrategy2', deposit: 5 }));
    t.apply(ev({ sig: '2', instr: 'ClosePosition2', withdraw: 4, blockTime: 2000 }));
    const p = t.apply(ev({ sig: '3', instr: 'ClosePosition2', withdraw: 1, blockTime: 3000 }));
    expect(p?.status).toBe('closed');
    expect(p?.closedAt).toBe(2000); // the 1st close is authoritative (guard status === 'open')
  });

  it('event without a position ("") → ignored (tx with no leg, e.g. pure InitializePosition, no capital)', () => {
    const t = new LeaderPositionTracker();
    expect(t.apply(ev({ sig: '1', instr: 'InitializePositionPda', position: '' }))).toBeUndefined();
    expect(t.all()).toHaveLength(0);
  });
});

describe('LeaderPositionTracker — close keys off the per-position `closed` flag, not the per-tx label (#29)', () => {
  it('★ a close signaled ONLY by `closed:true` (truncated/unclassifiable label) still marks the position closed', () => {
    // NO-MISS PILLAR: under 10KB log truncation the instruction label degrades to '(DLMM)' → classifyInstruction
    // yields null. The OLD label-only tracker left the position OPEN (missing the close). The decoded PositionClose
    // leg sets `closed:true`, and — via the shared `isCloseEvent`, exactly like dispatch.ts — the tracker honors it.
    const t = new LeaderPositionTracker();
    t.apply(ev({ sig: '1', instr: 'AddLiquidityByStrategy2', deposit: 5 }));
    const p = t.apply(
      ev({ sig: '2', instr: '(DLMM)', closed: true, withdraw: 4, blockTime: 2000 }),
    );
    expect(p?.status).toBe('closed');
    expect(p?.closedAt).toBe(2000);
    expect(t.openPositions()).toHaveLength(0);
  });

  it('★ close A + open B in ONE tx: A closes via its OWN `closed` flag even though the tx label is an ADD', () => {
    // The per-tx label is ONE value for BOTH legs (finding #37). If the tx is labeled by B's add, a label-only
    // tracker FAILS to close A. Each leg carries its own `closed`, so A (closed:true) closes while B (closed:false)
    // opens — the tracker and the router now agree on which position a close belongs to.
    const t = new LeaderPositionTracker();
    t.apply(ev({ sig: '0', instr: 'AddLiquidityByStrategy2', deposit: 5, position: 'A' }));
    const a = t.apply(
      ev({ sig: 's', instr: 'AddLiquidityByStrategy2', closed: true, withdraw: 5, position: 'A' }),
    );
    const b = t.apply(
      ev({ sig: 's', instr: 'AddLiquidityByStrategy2', closed: false, deposit: 4, position: 'B' }),
    );
    expect(a?.status).toBe('closed'); // A closed via its own leg, despite the add-labeled tx
    expect(b?.status).toBe('open'); // B opened, not spuriously closed
  });

  it('a partial withdraw (closed:false, unclassifiable label) still keeps the position OPEN — no false close', () => {
    // The mirror of the above: `closed:false` must NOT close on a truncated label; a partial is not a close.
    const t = new LeaderPositionTracker();
    t.apply(ev({ sig: '1', instr: 'AddLiquidityByStrategy2', deposit: 5 }));
    const p = t.apply(ev({ sig: '2', instr: '(DLMM)', closed: false, withdraw: 2 }));
    expect(p?.status).toBe('open');
  });
});

describe('LeaderPositionTracker — bounded appliedEvents dedup guard (#34)', () => {
  it('evicts the OLDEST applied key past the cap (bounds long-uptime growth; a recent key stays deduped)', () => {
    // WHY: the per-(sig,position) guard must not grow forever. Eviction is oldest-first, so only a re-observation of
    // an event so old it can no longer arrive (the WS/poll overlap is seconds) could re-apply — a bounded
    // double-count, never a MISS. The `positions` Map (the real state) is never evicted.
    const t = new LeaderPositionTracker(2); // cap = 2 applied keys
    t.apply(ev({ sig: '1', instr: 'AddLiquidityByStrategy2', deposit: 5, position: 'A' }));
    t.apply(ev({ sig: '2', instr: 'AddLiquidityByStrategy2', deposit: 7, position: 'B' }));
    t.apply(ev({ sig: '2', instr: 'AddLiquidityByStrategy2', deposit: 7, position: 'B' })); // recent → still deduped
    expect(t.get('B')).toMatchObject({ depositedSol: 7, eventCount: 1 });
    // A 3rd distinct key evicts the OLDEST (sig1|A); re-observing it is no longer idempotent → it re-applies.
    t.apply(ev({ sig: '3', instr: 'AddLiquidityByStrategy2', deposit: 9, position: 'C' }));
    t.apply(ev({ sig: '1', instr: 'AddLiquidityByStrategy2', deposit: 5, position: 'A' }));
    expect(t.get('A')).toMatchObject({ depositedSol: 10, eventCount: 2 }); // evicted key re-applied → proves the bound
  });
});
