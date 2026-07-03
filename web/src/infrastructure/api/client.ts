import type {
  AccessEntry,
  Bucket,
  Candle,
  ClosedPosition,
  NetworthCurve,
  PositionBins,
  PositionHistory,
  ProfitBucket,
  Stats,
  Wallet,
  WalletOverview,
  WalletPnlCurve,
  WalletState,
} from '@binsight/shared';
import { getAccessToken } from '@privy-io/react-auth';
import type { RpcTelemetry } from '@/domain/rpc-telemetry';
import { API_URL } from '@/infrastructure/config';

export type ClosedQuery = {
  q?: string;
  sort?: 'recent' | 'pnl' | 'fees' | 'duration';
  dir?: 'asc' | 'desc';
  result?: 'all' | 'win' | 'loss';
};

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;

/**
 * Auth failures are handled centrally (every call goes through {@link authedFetch}) and surfaced to
 * ONE registered handler — the auth gate — so a dead Privy session redirects to login with a visible
 * message and a lost account (403 needsInvite) re-opens the invite gate, instead of every data view
 * dealing with scattered 401/403s.
 */
export type AuthFailureKind = 'expired' | 'needsInvite';
type AuthFailureHandler = (kind: AuthFailureKind) => void;

let authFailureHandler: AuthFailureHandler | null = null;

/** Register the single auth-failure handler (the auth gate). Pass `null` to unregister. */
export function setAuthFailureHandler(handler: AuthFailureHandler | null): void {
  authFailureHandler = handler;
}

/**
 * Fetch `<API_URL>/<path>` with the Privy access token as Bearer. The token is asked fresh on every
 * call — the Privy SDK caches it and transparently refreshes it near expiry. A null token (no valid
 * session) and a 401 both mark the session expired; a 403 carrying `needsInvite` routes back to the
 * invite gate.
 */
async function authedFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const token = await getAccessToken();
  if (!token) {
    authFailureHandler?.('expired');
    throw new ApiError(`${init.method ?? 'GET'} ${path} unauthenticated`, HTTP_UNAUTHORIZED);
  }
  const headers = new Headers(init.headers);
  headers.set('authorization', `Bearer ${token}`);
  const res = await fetch(`${API_URL}/${path}`, { ...init, headers });
  if (res.status === HTTP_UNAUTHORIZED) {
    authFailureHandler?.('expired');
  } else if (res.status === HTTP_FORBIDDEN) {
    // Body is read on a clone so callers can still consume the original response.
    const body = (await res
      .clone()
      .json()
      .catch(() => ({}))) as { needsInvite?: boolean };
    if (body.needsInvite === true) authFailureHandler?.('needsInvite');
  }
  return res;
}

// Coalesce concurrent identical GETs into one in-flight request. Several components mount and request
// the same resource in the same React commit — PerformanceCard + PairsCard both GET /stats (A09), and a
// closed-set change re-fires every scoped query at once (O10) — so without this each fires its own
// round-trip to the API. Keyed by path and cleared the moment the request settles (resolve OR
// reject), so it only ever dedupes truly-concurrent calls and never serves a stale response. (Requests
// with different params — e.g. the period-scoped Net Worth curves, O06 — have different paths and are
// correctly NOT merged: they are distinct resources.)
const inflightGets = new Map<string, Promise<unknown>>();

async function get<T>(path: string): Promise<T> {
  const pending = inflightGets.get(path);
  if (pending) return pending as Promise<T>;
  const req = (async (): Promise<T> => {
    const res = await authedFetch(path, { headers: { accept: 'application/json' } });
    if (!res.ok) throw new ApiError(`GET ${path} failed (${res.status})`, res.status);
    return (await res.json()) as T;
  })();
  inflightGets.set(path, req);
  try {
    return await req;
  } finally {
    inflightGets.delete(path);
  }
}

async function send(
  path: string,
  method: 'POST' | 'PUT' | 'DELETE',
  body?: unknown,
): Promise<boolean> {
  try {
    const res = await authedFetch(path, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return res.ok;
  } catch {
    // A dead session throws before the request leaves — the auth gate is already redirecting.
    return false;
  }
}

async function getBlob(path: string, accept: string, signal?: AbortSignal): Promise<Blob> {
  const res = await authedFetch(path, { headers: { accept }, signal });
  if (!res.ok) throw new ApiError(`GET ${path} failed (${res.status})`, res.status);
  return res.blob();
}

type ClosedPage = { rows: ClosedPosition[]; total: number };

/** The caller's own identity (the registered branch of `/auth/me`). */
export type AccountIdentity = { address: string | null; isOwner: boolean };

/** `/auth/me`: registered accounts get their identity; a valid Privy login without an account row
 *  is told to redeem an invite. */
export type AuthMe =
  | ({ registered: true } & AccountIdentity)
  | { registered: false; needsInvite: true };

/** Typed client hitting the API origin directly (Privy token attached per request). */
export const api = {
  state: (scope: string) => get<WalletState>(`state?wallet=${encodeURIComponent(scope)}`),

  closed: (scope: string, page = 1, pageSize = 20, query: ClosedQuery = {}) => {
    const p = new URLSearchParams({
      wallet: scope,
      page: String(page),
      pageSize: String(pageSize),
    });
    if (query.q) p.set('q', query.q);
    if (query.sort) p.set('sort', query.sort);
    if (query.dir) p.set('dir', query.dir);
    if (query.result && query.result !== 'all') p.set('result', query.result);
    return get<ClosedPage>(`positions/closed?${p.toString()}`);
  },

  stats: (scope: string, since = 0) =>
    get<Stats>(`stats?wallet=${encodeURIComponent(scope)}${since > 0 ? `&since=${since}` : ''}`),

  profitHistory: (scope: string, bucket: Bucket, since = 0) =>
    get<ProfitBucket[]>(
      `stats/history?wallet=${encodeURIComponent(scope)}&bucket=${bucket}&since=${since}`,
    ),

  /** The TRUE wallet PnL curve from on-chain SOL cash-flow — captures rug/slippage losses the
   *  position-level history misses. `days` = window length. */
  walletPnlCurve: (scope: string, days: number) =>
    get<WalletPnlCurve>(`wallet/pnl-curve?wallet=${encodeURIComponent(scope)}&days=${days}`),

  /** The forward-only TRUE Net Worth curve (on-chain wallet total = tvl + idle, sampled over time). */
  networthCurve: (scope: string, days: number) =>
    get<NetworthCurve>(`networth/curve?wallet=${encodeURIComponent(scope)}&days=${days}`),

  /** SOL spot price in USD for the display-currency toggle (null when unavailable). */
  solUsd: () => get<{ price: number | null }>('sol-usd'),

  /** Web Push: fetch the VAPID public key, register/remove a browser subscription. */
  pushVapidKey: () => get<{ key: string }>('push/vapid-public-key'),
  pushSubscribe: (sub: unknown) => send('push/subscribe', 'POST', sub),
  pushUnsubscribe: (endpoint: string) => send('push/unsubscribe', 'POST', { endpoint }),
  pushTest: () => send('push/test', 'POST', {}),

  bins: (address: string) => get<PositionBins>(`positions/${address}/bins`),

  history: (address: string) => get<PositionHistory>(`positions/${address}/history`),

  /** The generated PnL share card (PNG) for a closed position, as a Blob. */
  positionCard: (address: string, signal?: AbortSignal) =>
    getBlob(`positions/${encodeURIComponent(address)}/card.png`, 'image/png', signal),

  /** OHLCV candles for a pool's price chart (SOL-priced). Empty `candles` ⇒ pool not indexed yet. */
  ohlcv: (pool: string, tf: string) =>
    get<{ candles: Candle[] }>(
      `pools/${encodeURIComponent(pool)}/ohlcv?tf=${encodeURIComponent(tf)}`,
    ),

  /** A single closed position by address — used to deep-link a position drawer from the URL. */
  position: (address: string) =>
    get<{ closed: ClosedPosition | null }>(`positions/${encodeURIComponent(address)}`),

  wallets: () => get<Wallet[]>('wallets'),

  addWallet: (address: string, label: string) => send('wallets', 'POST', { address, label }),

  removeWallet: (address: string) => send(`wallets/${encodeURIComponent(address)}`, 'DELETE'),

  refresh: () => send('refresh', 'POST'),

  // ── Admin (owner only — the backend re-checks isOwner on every call) ──────────────────────────
  /** Unified access list: invited (whitelisted) + joined (registered) accounts. */
  access: () => get<AccessEntry[]>('admin/access'),
  /** Invite an address (whitelist it so it can register). */
  invite: (address: string, note: string) => send('admin/access', 'POST', { address, note }),
  /** Revoke access: delete the account (if any) AND remove the invite. */
  revoke: (address: string) => send(`admin/access/${encodeURIComponent(address)}`, 'DELETE'),
  /** Operational overview of every monitored wallet. */
  adminWallets: () => get<WalletOverview[]>('admin/wallets'),
  /** RPC credit telemetry — totals, by-method/codePath/wallet breakdown, live tail, anomalies,
   *  kill-switch state, and the durable last-7d spend (owner only). */
  debugRpc: () => get<RpcTelemetry>('debug/rpc'),
};

/** Typed reasons a redeem can fail — mirrors the API's error codes exactly (plus `network`). */
export type RedeemInviteError =
  | 'invalid_code'
  | 'code_expired'
  | 'code_used'
  | 'already_registered'
  | 'network';

const REDEEM_ERROR_CODES: readonly RedeemInviteError[] = [
  'invalid_code',
  'code_expired',
  'code_used',
  'already_registered',
];

export type RedeemInviteResult = { ok: true } | { ok: false; error: RedeemInviteError };

/** Result of the WS-ticket fetch: a ticket, a dead session (stop reconnecting), or a transient
 *  failure (retry with backoff). */
export type WsTicketResult = { token: string } | { unauthorized: true } | null;

// ── Copy-bot operator admin (owner only — the backend re-checks isOwner on every call) ─────────────
/** One bot process's health, derived from heartbeat freshness. `detail` is loose jsonb → render defensively. */
export type CopybotProcessStatus = {
  ts: number;
  ageMs: number;
  online: boolean;
  detail: unknown;
};

export type CopybotStatusView = {
  brain: CopybotProcessStatus | null;
  coffre: CopybotProcessStatus | null;
};

/** A quarantine/alert row (a projection of copy_journal): a pinned SYSTEM event the operator must see. */
export type CopybotQuarantineRow = {
  id: number;
  ts: number;
  code: string | null;
  severity: string;
  wallet: string | null;
  userId: string | null;
  correlationId: string | null;
  reason: string | null;
  leader: string | null;
  detail: unknown;
};

/** Result of a GLOBAL KILL: how many user configs the halt now covers. */
export type CopybotKillResult = { killed: number };

/** Copy-bot operator admin surface (SPEC §10/§13). Owner-gated server-side. */
export const adminApi = {
  /** Brain/coffre process health (online/stale + the per-user/per-leader snapshot). */
  copybotStatus: () => get<CopybotStatusView>('admin/copybot/status'),

  /** Recent pinned SYSTEM alerts (quarantined forged commands / fatal stops / blind detectors), newest first. */
  copybotQuarantine: (limit?: number) =>
    get<CopybotQuarantineRow[]>(`admin/copybot/quarantine${limit ? `?limit=${limit}` : ''}`),

  /**
   * GLOBAL KILL — force killSwitchGlobal ON for every user (SPEC §13 away-from-desk halt). Returns the count on
   * success and THROWS a typed {@link ApiError} otherwise, so the UI can read back status and never render an
   * optimistic "killed" it can't confirm.
   */
  async copybotKill(): Promise<CopybotKillResult> {
    const res = await authedFetch('admin/copybot/kill', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ level: 'global' }),
    });
    if (!res.ok) throw new ApiError(`POST admin/copybot/kill failed (${res.status})`, res.status);
    return (await res.json()) as CopybotKillResult;
  },
};

/** Auth endpoints (Privy token → binsight account). Sessions themselves are 100% Privy. */
export const authApi = {
  /** The caller's account state. Works pre-account so the gate can decide invite vs app. */
  me: () => get<AuthMe>('auth/me'),

  /** Redeem a single-use invite code to create the binsight account for this Privy identity. */
  async redeemInvite(code: string): Promise<RedeemInviteResult> {
    let res: Response;
    try {
      res = await authedFetch('auth/redeem-invite', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code }),
      });
    } catch {
      return { ok: false, error: 'network' };
    }
    if (res.ok) return { ok: true };
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    const known = REDEEM_ERROR_CODES.find((reason) => reason === data.error);
    return { ok: false, error: known ?? 'network' };
  },

  /** Short-lived ticket for the `/live` WebSocket (browsers can't set WS headers). */
  async wsTicket(): Promise<WsTicketResult> {
    let res: Response;
    try {
      res = await authedFetch('auth/ws-ticket');
    } catch (err) {
      if (err instanceof ApiError && err.status === HTTP_UNAUTHORIZED) {
        return { unauthorized: true };
      }
      return null;
    }
    if (res.status === HTTP_UNAUTHORIZED) return { unauthorized: true };
    if (!res.ok) return null;
    const { token } = (await res.json()) as { token: string };
    return { token };
  },
};
