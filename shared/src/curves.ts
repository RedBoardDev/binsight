/* ────────────────────────────────────────────────────────────────────────
 * Wallet PnL curve (true realized SOL from on-chain cash-flow) — server DTO
 * ──────────────────────────────────────────────────────────────────────── */

/** One day of the wallet PnL cash-flow curve (the TRUE realized SOL, incl. rug/slippage losses). */
export interface WalletPnlDay {
  /** YYYY-MM-DD (UTC) */
  date: string;
  /** net trading SOL flow that day (the realized PnL increment). */
  tradingSol: number;
  /** net external SOL flow that day (funding / withdrawals — shown apart, not PnL). */
  externalSol: number;
  /** running cumulative trading SOL since the window start (the curve). */
  cumulativeSol: number;
  /** running cumulative of (trading+external) = reconstructed on-chain cash balance (reconciles with getBalance) */
  cumulativeTotalSol: number;
}

export interface WalletPnlCurve {
  /** the daily wallet PnL series (trading SOL flow, cumulative, external flow apart). */
  days: WalletPnlDay[];
  /** realized trading PnL over the window (= the final cumulative). */
  totalTradingSol: number;
  /** net external (CEX / non-trading) SOL movement over the window — shown apart, not PnL. */
  totalExternalSol: number;
  /** false if any requested wallet's on-chain history isn't fully ingested yet (curve still building). */
  complete: boolean;
}

/* ────────────────────────────────────────────────────────────────────────
 * Net Worth curve (forward-only TRUE on-chain wallet total over time) — server DTO
 * ──────────────────────────────────────────────────────────────────────── */

/** One reconstructed Net Worth + PnL point (per UTC day). */
export interface NetworthCurvePoint {
  /** YYYY-MM-DD (UTC). */
  date: string;
  /** The wallet VALUE at end of that day (cum_trading + cum_ext + deployed; ≥0 in practice; reconciles
   *  with the hero walletTotalSol). Falls to 0 if emptied — never negative. */
  networth: number;
  /** Cumulative net deposits (cum_ext = deposits − withdrawals) up to end of that day. */
  apports: number;
  /** The PERFORMANCE net of apports (= networth − apports = cum_trading + deployed). CAN be negative. */
  realPnl: number;
}

export interface NetworthCurve {
  points: NetworthCurvePoint[];
}
