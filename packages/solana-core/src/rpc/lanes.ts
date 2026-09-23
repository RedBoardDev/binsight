import { Connection } from '@solana/web3.js';
import type { CreditMeter } from './credit-meter';
import { SolanaRpcRateLimiter } from './rate-limiter';

/** The provider plan's per-second limits (Helius free tier by default). */
export interface RpcPlan {
  rps: number;
  gpaRps: number;
  dasRps: number;
  sendRps: number;
  /** Share of the overall budget reserved for the live lane (snapshots, valuation, on-demand reads). */
  liveFraction: number;
}

/**
 * We target this fraction of each plan limit: the provider's sliding-window counter 429s at exactly
 * the ceiling.
 */
export const RPS_SAFETY = 0.85;

export interface RpcLanes {
  /** Snapshots, valuation, on-demand reads. Holds the full per-method limits (it is the only gPA user). */
  live: Connection;
  /** History ingest and projection reads. Capped at the remaining overall budget so a backfill can
   *  never starve the live lane. It issues only "other" methods, so its sub-limits never bind. */
  backfill: Connection;
  stats(): {
    live: ReturnType<SolanaRpcRateLimiter['stats']>;
    backfill: ReturnType<SolanaRpcRateLimiter['stats']>;
  };
}

/** Two Connections sharing one plan: every call on either is gated by its lane's limiter and metered. */
export function createRpcLanes(httpUrl: string, plan: RpcPlan, meter: CreditMeter): RpcLanes {
  const liveLimiter = new SolanaRpcRateLimiter(
    {
      rps: plan.rps * RPS_SAFETY * plan.liveFraction,
      gpaRps: plan.gpaRps * RPS_SAFETY,
      dasRps: plan.dasRps * RPS_SAFETY,
      sendRps: plan.sendRps * RPS_SAFETY,
    },
    undefined,
    meter,
  );
  const backfillRps = plan.rps * RPS_SAFETY * (1 - plan.liveFraction);
  const backfillLimiter = new SolanaRpcRateLimiter(
    { rps: backfillRps, gpaRps: backfillRps, dasRps: backfillRps, sendRps: backfillRps },
    undefined,
    meter,
  );
  const connection = (limiter: SolanaRpcRateLimiter) =>
    new Connection(httpUrl, { commitment: 'confirmed', fetchMiddleware: limiter.middleware() });
  return {
    live: connection(liveLimiter),
    backfill: connection(backfillLimiter),
    stats: () => ({ live: liveLimiter.stats(), backfill: backfillLimiter.stats() }),
  };
}
