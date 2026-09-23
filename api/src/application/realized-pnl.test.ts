import { SOL_MINT } from '@binsight/shared';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import type { Logger } from 'pino';
import { describe, expect, it, vi } from 'vitest';
import type { LoadedPoolMeta, ResidualSell, StoredLeg, SwapFlowRow, SwapSide } from '@/domain/dlmm';
import type { Database } from '@/infrastructure/persistence/database';
import { PostgresIngestCursorRepository } from '@/infrastructure/persistence/ingest-cursor-repository';
import * as schema from '@/infrastructure/persistence/schema';
import { SwapFlowRepository } from '@/infrastructure/persistence/swap-flow-repository';
import {
  type RealizedLegSource,
  RealizedPnlEngine,
  type RealizedPositionSource,
} from './realized-pnl';

const noopLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as unknown as Logger;

const MINT = 'MintMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMM';
const POOL = 'PoolPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPP';
const LAMPORTS = 1e9;
const WALLET = 'W';

// solSide = 'Y' → mintX = the token, mintY = SOL → a leg's amountX is raw token, amountY is lamports.
const POOL_META: LoadedPoolMeta = { binStep: 1, solSide: 'Y', mintX: MINT, mintY: SOL_MINT };

let seq = 0;
/** A token-side DLMM leg (decimals=0 → raw amount = human amount). */
function leg(
  position: string,
  kind: StoredLeg['kind'],
  tokenQty: number,
  sol: number,
  blockTime: number,
): StoredLeg {
  return {
    signature: `sig${String(seq++).padStart(4, '0')}`,
    position,
    lbPair: POOL,
    kind,
    activeBinId: 0, // bin price = 1 → SOL per raw token = 1 (×10^0 / 1e9 = 1e-9 SOL/token at decimals 0)
    amountX: BigInt(tokenQty),
    amountY: BigInt(Math.round(sol * LAMPORTS)),
    blockTime,
  };
}

// Real SwapFlowRepository + ingest cursor over an in-memory Postgres (PGlite) — NO network — so the
// engine exercises the REAL DB read path (byWallet ordering + side→buys/sells mapping + the ingest-cursor
// completeness gate), not a mocked source. This is the realized-PnL FIFO's only input source.
async function newRepos(): Promise<{
  repo: SwapFlowRepository;
  cursors: PostgresIngestCursorRepository;
}> {
  const db = drizzle(new PGlite(), { schema });
  await migrate(db, { migrationsFolder: './drizzle' });
  const d = db as unknown as Database;
  return { repo: new SwapFlowRepository(d), cursors: new PostgresIngestCursorRepository(d) };
}

let swapSeq = 0;
/** Map a fixture buy/sell (ResidualSell shape) to a persisted swap_flows row: solReceived = solAmount
 *  (SOL SPENT for a buy, SOL RECEIVED for a sell); unique signature satisfies the (wallet,sig,mint) PK. */
function toRows(side: SwapSide, flows: ResidualSell[]): SwapFlowRow[] {
  return flows.map((f) => ({
    wallet: WALLET,
    signature: `swap${String(swapSeq++).padStart(4, '0')}`,
    ts: f.ts,
    mint: f.mint,
    tokenAmount: f.tokenAmount,
    solAmount: f.solReceived,
    side,
  }));
}

async function seedSwaps(
  repo: SwapFlowRepository,
  cursors: PostgresIngestCursorRepository,
  opts: { buys: ResidualSell[]; sells: ResidualSell[]; complete?: boolean; noCursor?: boolean },
): Promise<void> {
  await repo.upsertMany([...toRows('buy', opts.buys), ...toRows('sell', opts.sells)]);
  if (!opts.noCursor) {
    // A completed ingest cursor = the realized FIFO may read the persisted history as whole.
    await cursors.set(WALLET, {
      oldestSig: 'genesis',
      newestSig: 'top',
      complete: opts.complete ?? true,
    });
  }
}

async function makeEngine(opts: {
  legs: StoredLeg[];
  status: Map<string, { status: string; closedAt: number | null }>;
  buys: ResidualSell[];
  sells: ResidualSell[];
  complete?: boolean;
  noCursor?: boolean;
  /** Token decimals of MINT (default 0 → human == raw, keeps the hand math exact). */
  decimals?: number;
}): Promise<{
  engine: RealizedPnlEngine;
  repo: SwapFlowRepository;
  cursors: PostgresIngestCursorRepository;
}> {
  const { repo, cursors } = await newRepos();
  await seedSwaps(repo, cursors, opts);
  const legSource: RealizedLegSource = {
    legsByWallet: async () => opts.legs,
    getPoolMetas: async () => new Map([[POOL, POOL_META]]),
  };
  const posSource: RealizedPositionSource = {
    positionStatusForWallet: async () => opts.status,
  };
  // Batched decimals fetch (one call for all mints).
  const engine = new RealizedPnlEngine(
    legSource,
    posSource,
    repo,
    cursors,
    async (mints: string[]) => new Map<string, number>(mints.map((m) => [m, opts.decimals ?? 0])),
    noopLogger,
  );
  return { engine, repo, cursors };
}

describe('RealizedPnlEngine — chained FIFO cost-basis (persisted swap_flows)', () => {
  it('routes the realized gain to the producing position across a deposit→withdraw→re-deposit→sell chain', async () => {
    // Timeline on mint M (all amounts human; decimals 0):
    //  buy 100 @0.1 SOL  → lot {100,0.1,null}
    //  P1 deposit 100, 10 SOL → solLeg -10, entryCost 10 (consumes the buy)
    //  P1 withdraw 100, 5 SOL → solLeg -5, exitCredit 10, lot {100,0.1,P1}
    //  P2 deposit 100, 5 SOL  → solLeg -5, entryCost 10 (consumes P1's withdrawn lot)
    //  P2 withdraw 100, 8 SOL → solLeg 3, exitCredit 10, lot {100,0.1,P2}
    //  sell 100 for 20 SOL    → gain 20 − 10 = 10 → realizedGain[P2]
    // PnL(P1) = -5 − 10 + 10 + 0 + 0 = -5 ; PnL(P2) = 3 − 10 + 10 + 10 + 0 = 13
    // Same fixtures as before, but buys/sells now come from the seeded swap_flows DB rows, not a fetch.
    const legs = [
      leg('P1', 'deposit', 100, 10, 1000),
      leg('P1', 'withdraw', 100, 5, 2000),
      leg('P2', 'deposit', 100, 5, 3000),
      leg('P2', 'withdraw', 100, 8, 4000),
    ];
    const status = new Map([
      ['P1', { status: 'closed', closedAt: 2000_000 }],
      ['P2', { status: 'closed', closedAt: 4000_000 }],
    ]);
    const { engine } = await makeEngine({
      legs,
      status,
      buys: [{ ts: 500, mint: MINT, tokenAmount: 100, solReceived: 10 }],
      sells: [{ ts: 5000, mint: MINT, tokenAmount: 100, solReceived: 20 }],
    });

    const out = await engine.computeForWallet(WALLET);
    expect(out).not.toBeNull();
    expect(out!.byPosition.get('P1')).toBeCloseTo(-5, 9);
    expect(out!.byPosition.get('P2')).toBeCloseTo(13, 9);
    // Wallet conservation: Σ PnL = Σ solLeg + (Σ sells − Σ buys) when nothing is still held.
    expect((out!.byPosition.get('P1') ?? 0) + (out!.byPosition.get('P2') ?? 0)).toBeCloseTo(
      -2 + (20 - 10),
      9,
    );
  });

  it('marks a FRESH still-held residual at the CLOSE-bin price, NOT the current market price (died-token regression)', async () => {
    // WHY (regression): a token that DIED after close has a current price ~0. The OLD code marked the held
    // residual at min(currentPrice, close-bin) → ~0 → a spurious full -deposit loss (SOLANGELES showed -13
    // where LPAgent shows 0.00). Mark-to-market-AT-CLOSE (LPAgent's model) uses the CLOSE-bin price and
    // ignores the current price entirely; the later residual sells are wallet-level trading, not this close.
    // P2 locks bought tokens (no SOL side), withdraws them, never sells → a still-held bag.
    //  buy 100 @0.1 → lot{100,0.1,null}; P2 deposit 100,0 → entryCost 10; P2 withdraw 100,0 → exitCredit 10, held lot{100,0.1,P2}
    // bin price = 1, solSide Y, decimals 0 → close-bin mark = (1 × 10^0)/1e9 = 1e-9 SOL/token.
    // The held lot is counted at qty × (mark − costPerUnit): its 0.1 basis was already credited back as
    // exitCredit, so only the mark's gain/loss over it is PnL → held = 100 × (1e-9 − 0.1) = 1e-7 − 10.
    //   PnL(P2) = 0 − 10 + 10 + (1e-7 − 10) = 1e-7 − 10.
    // (CHANGED from +1e-7: the old walk added the bag's full value on top of the credited basis — the
    // basis was counted twice. The bag really did lose ~10 SOL of basis at a 1e-9 close-bin price.)
    // A current-price mark (1e-10 for a died token) would give 1e-8 − 10 instead; the 1e-7 term is
    // what proves the close-bin mark was used.
    const legs = [leg('P2', 'deposit', 100, 0, 1000), leg('P2', 'withdraw', 100, 0, 2000)];
    const status = new Map([
      ['P2', { status: 'closed', closedAt: Date.now() - 1000 }], // fresh (<7d) → close-bin mark, no current price
    ]);
    const { engine } = await makeEngine({
      legs,
      status,
      buys: [{ ts: 500, mint: MINT, tokenAmount: 100, solReceived: 10 }],
      sells: [],
    });

    const out = await engine.computeForWallet(WALLET);
    expect(out).not.toBeNull();
    expect(out!.byPosition.size).toBe(1);
    expect(out!.byPosition.get('P2')).toBeCloseTo(1e-7 - 10, 10); // close-bin mark (1e-9), NOT the current 1e-10
  });

  it('returns null (skip persist) when the ingest cursor is incomplete (backfill unfinished)', async () => {
    // A still-backfilling wallet has a cursor with complete=false → the persisted swap history is partial.
    // The engine must NOT hand back values to persist — an under-consumed FIFO would leave too much "held"
    // residual and overwrite good market_pnl_sol with inflated values. Same protection the old
    // incomplete-Enhanced-fetch guard gave, now driven by the cursor.
    const legs = [leg('P1', 'deposit', 100, 10, 1000), leg('P1', 'withdraw', 100, 5, 2000)];
    const status = new Map([['P1', { status: 'closed', closedAt: 2000_000 }]]);
    const { engine } = await makeEngine({
      legs,
      status,
      buys: [{ ts: 500, mint: MINT, tokenAmount: 100, solReceived: 10 }],
      sells: [{ ts: 5000, mint: MINT, tokenAmount: 100, solReceived: 20 }],
      complete: false, // seed unfinished → skip signal
    });

    expect(await engine.computeForWallet(WALLET)).toBeNull();
  });

  it('returns null (skip persist) when the wallet has no ingest cursor yet (never ingested)', async () => {
    // No cursor at all = the ingest has not started (a brand-new wallet). The persisted history is
    // necessarily partial → skip persist, never inflate.
    const legs = [leg('P1', 'deposit', 100, 10, 1000), leg('P1', 'withdraw', 100, 5, 2000)];
    const status = new Map([['P1', { status: 'closed', closedAt: 2000_000 }]]);
    const { engine } = await makeEngine({
      legs,
      status,
      buys: [{ ts: 500, mint: MINT, tokenAmount: 100, solReceived: 10 }],
      sells: [{ ts: 5000, mint: MINT, tokenAmount: 100, solReceived: 20 }],
      noCursor: true,
    });

    expect(await engine.computeForWallet(WALLET)).toBeNull();
  });

  it('returns an empty map (not null) when the wallet has no DLMM legs (callers untouched)', async () => {
    // Distinct from the null guard: no legs at all → nothing to compute, return an EMPTY map (not null)
    // so callers leave existing values untouched without treating it as a skip-on-incomplete-history.
    // The no-legs short-circuit fires BEFORE the cursor read, so a missing cursor is irrelevant here.
    const { engine } = await makeEngine({
      legs: [],
      status: new Map(),
      buys: [],
      sells: [],
      noCursor: true,
    });
    const out = await engine.computeForWallet(WALLET);
    expect(out).not.toBeNull();
    expect(out!.byPosition.size).toBe(0);
  });

  it('sources buys/sells exclusively from the persisted swap_flows repo (no Enhanced API in the realized path)', async () => {
    // Proves the realized engine reads its FIFO inputs from the DB: the ingest cursor (completeness) +
    // byWallet (the rows) are the ONLY input source. The constructor accepts no transaction gateway, so
    // there is no fetch to make — this asserts the DB read actually happens and feeds the result.
    const legs = [leg('P1', 'deposit', 100, 10, 1000), leg('P1', 'withdraw', 100, 5, 2000)];
    const status = new Map([['P1', { status: 'closed', closedAt: 2000_000 }]]);
    const { engine, repo, cursors } = await makeEngine({
      legs,
      status,
      buys: [{ ts: 500, mint: MINT, tokenAmount: 100, solReceived: 10 }],
      sells: [{ ts: 5000, mint: MINT, tokenAmount: 100, solReceived: 20 }],
    });
    const getCursorSpy = vi.spyOn(cursors, 'get');
    const byWalletSpy = vi.spyOn(repo, 'byWallet');

    const out = await engine.computeForWallet(WALLET);

    expect(getCursorSpy).toHaveBeenCalledWith(WALLET);
    expect(byWalletSpy).toHaveBeenCalledWith(WALLET);
    // Single position: solLeg(-5) − entryCost(10) + exitCredit(10) + realizedGain(20−10) = +5. The
    // persisted buy (cost basis) AND sell (proceeds) both came from swap_flows, so a non-trivial value
    // proves the DB rows actually drove the FIFO result (not an empty/mocked source).
    expect(out!.byPosition.get('P1')).toBeCloseTo(5, 9);
  });

  it('recomputes from the persisted swaps + a freshly-ingested delta, not a re-fetch (a late sell converges)', async () => {
    // A position closes holding its residual; the close-time pass runs BEFORE the dump is persisted, so it
    // marks the residual as held. Once the residual sell is INGESTED into swap_flows (the delta the
    // transaction ingest persists), a re-read of the SAME table must pick it up and converge to the
    // realized value — no full re-page, just the persisted delta. WHY: this is what makes a restart/close
    // ~0-credit.
    const legs = [leg('P1', 'deposit', 100, 10, 1000), leg('P1', 'withdraw', 100, 5, 2000)];
    const status = new Map([['P1', { status: 'closed', closedAt: 2000_000 }]]);
    const { engine, repo } = await makeEngine({
      legs,
      status,
      buys: [{ ts: 500, mint: MINT, tokenAmount: 100, solReceived: 10 }],
      sells: [], // residual not yet sold/indexed at close time
    });

    // 1) Cold pass — residual still held, no realized sale yet. The close is aged (closedAt 2000 s) and
    //    no sell lies near it, so the mark is min(localPrice 0, close-bin) = 0. The withdrawn lot
    //    {100, 0.1} counts qty × (mark − cost) = 100 × (0 − 0.1) = −10:
    //    PnL = solLeg(−5) − entryCost(10) + exitCredit(10) + held(−10) = −15.
    //    (CHANGED from −5: the old walk counted the held lot at qty × mark = 0 while keeping its credited
    //    basis, so a worthless bag looked 10 SOL better than it is. −15 → −7 once it is sold for 8.)
    const first = await engine.computeForWallet(WALLET);
    expect(first!.byPosition.get('P1')).toBeCloseTo(-15, 4);

    // 2) The dump lands and SwapFlowIngest persists it (the delta) — a re-read converges to -7.
    await repo.upsertMany(
      toRows('sell', [{ ts: 2100, mint: MINT, tokenAmount: 100, solReceived: 8 }]),
    );
    const second = await engine.computeForWallet(WALLET);
    expect(second!.byPosition.get('P1')).toBeCloseTo(-7, 4);
  });
});

describe('RealizedPnlEngine — realized PnL that belongs to no position', () => {
  it('routes a buy→sell round trip with no position to tradingPnlSol, never to a position', async () => {
    // WHY: the FIFO walk attaches each sale's gain to the position whose withdrawal supplied the tokens.
    // A token bought and sold on the side has no such origin. That branch used to be computed and thrown
    // away, so the reported realized PnL was only the position half of what the wallet actually did —
    // on a real wallet, +13.8 SOL of position PnL was shown while −11.8 SOL of speculation stayed hidden.
    const legs = [leg('P1', 'deposit', 100, 10, 1000), leg('P1', 'withdraw', 100, 10, 2000)];
    const status = new Map([['P1', { status: 'closed', closedAt: 2000_000 }]]);
    const { engine } = await makeEngine({
      legs,
      status,
      // A first pair feeds the position; a SECOND, later pair is pure speculation sold at a loss.
      buys: [
        { ts: 500, mint: MINT, tokenAmount: 100, solReceived: 10 },
        { ts: 6000, mint: MINT, tokenAmount: 50, solReceived: 20 },
      ],
      sells: [
        { ts: 3000, mint: MINT, tokenAmount: 100, solReceived: 10 },
        { ts: 7000, mint: MINT, tokenAmount: 50, solReceived: 8 },
      ],
    });

    const out = await engine.computeForWallet(WALLET);
    expect(out).not.toBeNull();
    // The speculative leg lost 12 SOL (bought 20, sold 8) and lands OUTSIDE any position.
    expect(out!.tradingPnlSol).toBeCloseTo(-12, 6);
    // The position keeps only what its own tokens produced — the loss must not leak into it.
    expect(out!.byPosition.get('P1')).toBeCloseTo(0, 6);
  });

  it('reports zero when every sale traces back to a position', async () => {
    const legs = [leg('P1', 'deposit', 100, 10, 1000), leg('P1', 'withdraw', 100, 5, 2000)];
    const status = new Map([['P1', { status: 'closed', closedAt: 2000_000 }]]);
    const { engine } = await makeEngine({
      legs,
      status,
      buys: [{ ts: 500, mint: MINT, tokenAmount: 100, solReceived: 10 }],
      sells: [{ ts: 3000, mint: MINT, tokenAmount: 100, solReceived: 20 }],
    });

    const out = await engine.computeForWallet(WALLET);
    expect(out!.tradingPnlSol).toBeCloseTo(0, 9);
  });

  it('reports zero for a wallet with no legs at all, without throwing', async () => {
    const { engine } = await makeEngine({ legs: [], status: new Map(), buys: [], sells: [] });
    const out = await engine.computeForWallet(WALLET);
    expect(out).toEqual({ byPosition: new Map(), tradingPnlSol: 0 });
  });
});

describe('RealizedPnlEngine — a held residual is not double counted', () => {
  it('buy 100 for 10 SOL, deposit, withdraw, hold at the same price → ≈ 0 (was +10)', async () => {
    // WHY: a withdrawn lot comes back carrying its basis, which the walk already credits as exitCredit.
    // Counting the held bag at its full value on top of that counted the basis twice: a round trip that
    // made and lost nothing showed +10 SOL.
    // decimals 8 + bin price 1 (binId 0) → close-bin mark = 1 × 10^8 / 1e9 = 0.1 SOL/token = the buy price.
    //  buy 100 @0.1 → lot{100,0.1,null}; deposit 100 (0 SOL) → entryCost 10;
    //  withdraw 100 (0 SOL) → exitCredit 10, held lot{100,0.1,P}
    //  held = 100 × (0.1 − 0.1) = 0 → PnL = 0 − 10 + 10 + 0 = 0   (old: + 100 × 0.1 = +10)
    const RAW = 100 * 1e8;
    const legs = [leg('P', 'deposit', RAW, 0, 1000), leg('P', 'withdraw', RAW, 0, 2000)];
    const status = new Map([['P', { status: 'closed', closedAt: Date.now() - 1000 }]]); // fresh → bin mark
    const { engine } = await makeEngine({
      legs,
      status,
      decimals: 8,
      buys: [{ ts: 500, mint: MINT, tokenAmount: 100, solReceived: 10 }],
      sells: [],
    });

    const out = await engine.computeForWallet(WALLET);
    expect(out!.byPosition.get('P')).toBeCloseTo(0, 9);
    expect(out!.tradingPnlSol).toBeCloseTo(0, 9);
  });

  it('claimed fee tokens still held count at their full value (zero basis)', async () => {
    // The other half of the rule: a claim brings tokens back with cost 0, so the whole mark is PnL.
    //  claim 50 tokens + 1 SOL → solLeg 1, lot{50,0,P}; held = 50 × (0.1 − 0) = 5 → PnL = 1 + 5 = 6
    const legs = [leg('P', 'claim', 50 * 1e8, 1, 1000)];
    const status = new Map([['P', { status: 'closed', closedAt: Date.now() - 1000 }]]);
    const { engine } = await makeEngine({ legs, status, decimals: 8, buys: [], sells: [] });

    const out = await engine.computeForWallet(WALLET);
    expect(out!.byPosition.get('P')).toBeCloseTo(6, 9);
  });
});
