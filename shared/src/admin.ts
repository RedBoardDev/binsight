/* ────────────────────────────────────────────────────────────────────────
 * Admin DTOs (owner-only views) — server-produced, no runtime schema
 * ──────────────────────────────────────────────────────────────────────── */

/** One row of the unified admin access view (whitelist invites + registered accounts, merged by address). */
export interface AccessEntry {
  address: string;
  status: 'invited' | 'joined';
  isOwner: boolean;
  note: string;
  /** Wallets this account watches (empty for an invited-but-not-yet-joined address). */
  wallets: string[];
  createdAt: number;
}

/** One monitored wallet's operational stats for the admin Wallets tab. The repository produces the
 *  core fields; the `/admin/wallets` route enriches each row with live ingest status (`ready` /
 *  `indexedTxs`), so those are optional on the wire. */
export interface WalletOverview {
  address: string;
  /** Number of accounts currently watching this wallet (shared monitoring; data loaded once). */
  watchers: number;
  openPositions: number;
  closedPositions: number;
  /** Epoch ms of the last position sync for this wallet (null if never synced). */
  lastUpdate: number | null;
  /** Live ingest status (route-enriched): false while the wallet's history is still being indexed. */
  ready?: boolean;
  /** Txs ingested so far during the initial backfill. */
  indexedTxs?: number;
}
