import { type ClosedPosition, type OpenPosition, SOL_MINT } from '@binsight/shared';
import type { Logger } from 'pino';
import type { OnchainValued, OnchainWalletSnapshot } from '@/domain/dlmm';
import type { PositionStore, TokenMetadataGateway } from '@/domain/ports';
import { isOutOfRange } from '@/domain/position';
import type { PositionPnl } from './dlmm-position-pnl';
import { buildPositionRows, snapshotToLive, type TokenMetaResolver } from './position-sync';

/** The leg-derived projection source (DlmmPositionPnl, narrowed for testability). */
export interface LegProjectionSource {
  pnlByPosition(wallet: string): Promise<PositionPnl[]>;
  pnlForPositions(positions: string[]): Promise<PositionPnl[]>;
}

type SyncRepo = Pick<
  PositionStore,
  'replaceOpenForWallet' | 'upsertClosed' | 'getOpenOrPendingClose' | 'strategiesOf'
>;

/** What changed in a wallet's open set since the persisted one. */
export interface OpenTransitions {
  opened: OpenPosition[];
  outOfRange: OpenPosition[];
  backInRange: OpenPosition[];
  /** Previously open positions the snapshot no longer holds (a close whose legs aren't projected yet). */
  vanished: string[];
}

export interface SyncResult {
  openPositions: OpenPosition[];
  /** Closed positions in the whole projection. */
  closed: number;
  /** Only the positions that went open → closed in this sync (the close-notification trigger). */
  closedRows: ClosedPosition[];
  transitions: OpenTransitions;
}

/**
 * Reconciles the `positions` table for a wallet entirely from chain. Two paths so the read/write cost
 * matches what changed:
 *   - `sync` (after an ingest found transactions): full reproject of open + closed from every leg.
 *   - `refreshOpen` (the snapshot cadence): only the open positions' live values.
 */
export class PositionSync {
  constructor(
    private readonly legPnl: LegProjectionSource,
    private readonly metadata: TokenMetadataGateway,
    private readonly repo: SyncRepo,
    private readonly logger: Logger,
  ) {}

  async sync(
    wallet: string,
    snapshot: OnchainWalletSnapshot,
    valued: OnchainValued,
  ): Promise<SyncResult> {
    const projection = await this.legPnl.pnlByPosition(wallet);
    const { open, closed, prior } = await this.buildRows(wallet, projection, snapshot, valued);
    // Newly closed = a closed row that was OPEN in the persisted set just before this sync. This diff
    // is the notification trigger and cannot spam or repeat: a wallet's first sync has no persisted open
    // set, and `replaceOpenForWallet` below drops the closed address from it for the next sync.
    const closedRows = closed.filter((c) => prior.has(c.positionAddress));
    await this.repo.replaceOpenForWallet(wallet, open, unprojected(snapshot, projection));
    if (closed.length) await this.repo.upsertClosed(closed);
    this.logger.info(
      { wallet, open: open.length, closed: closed.length, newlyClosed: closedRows.length },
      'positions reprojected from chain',
    );
    return {
      openPositions: open,
      closed: closed.length,
      closedRows,
      transitions: transitionsOf(prior, open, new Set(closedRows.map((c) => c.positionAddress))),
    };
  }

  /** Cadence refresh of just the OPEN positions' live values; never writes the closed history. */
  async refreshOpen(
    wallet: string,
    snapshot: OnchainWalletSnapshot,
    valued: OnchainValued,
  ): Promise<{ openPositions: OpenPosition[]; transitions: OpenTransitions }> {
    const openAddrs = snapshot.positions.map((p) => p.positionAddress);
    const projection = openAddrs.length > 0 ? await this.legPnl.pnlForPositions(openAddrs) : [];
    const { open, prior } = await this.buildRows(wallet, projection, snapshot, valued);
    await this.repo.replaceOpenForWallet(wallet, open, unprojected(snapshot, projection));
    return { openPositions: open, transitions: transitionsOf(prior, open, new Set()) };
  }

  private async buildRows(
    wallet: string,
    projection: PositionPnl[],
    snapshot: OnchainWalletSnapshot,
    valued: OnchainValued,
  ): Promise<{ open: OpenPosition[]; closed: ClosedPosition[]; prior: Map<string, OpenPosition> }> {
    const live = snapshotToLive(snapshot.positions, valued);
    // Both sides of every pair: a pool's quote side is labelled from the metadata of its quote mint.
    const mints = new Set<string>([SOL_MINT]);
    for (const p of projection) {
      mints.add(p.tokenMint);
      mints.add(p.quoteMint);
    }
    const metaMap = await this.metadata.resolve([...mints]);
    const resolver: TokenMetaResolver = (mint) => metaMap.get(mint) ?? { symbol: shortMint(mint) };
    const strategy = await this.repo.strategiesOf(projection.map((p) => p.position));
    // The persisted open set right before this sync — the source of truth for transitions. It includes
    // 'pending_close' rows: a position the cadence already saw vanish is still an open → closed
    // transition when this sync reprojects its close.
    const prior = new Map<string, OpenPosition>();
    const priorOorSince = new Map<string, number | null>();
    for (const o of await this.repo.getOpenOrPendingClose(wallet)) {
      prior.set(o.positionAddress, o);
      priorOorSince.set(o.positionAddress, o.outOfRangeSince ?? null);
    }
    const rows = buildPositionRows({
      wallet,
      projection,
      live,
      meta: resolver,
      strategy,
      priorOorSince,
      now: Date.now(),
    });
    return { ...rows, prior };
  }
}

const shortMint = (mint: string) => `${mint.slice(0, 4)}…${mint.slice(-4)}`;

/** Live positions the projection could not build (legs not ingested yet, or pool metadata that failed
 *  to load). They are still open on-chain: their row is left as it is instead of going to
 *  'pending_close', which would read as a close. */
function unprojected(snapshot: OnchainWalletSnapshot, projection: PositionPnl[]): string[] {
  const projected = new Set(projection.map((p) => p.position));
  return snapshot.positions.map((p) => p.positionAddress).filter((a) => !projected.has(a));
}

/** Diff the persisted open set against the new one. `closedNow` are vanished positions this sync
 *  already reports as closed — they are not "vanished" any more. */
function transitionsOf(
  prior: Map<string, OpenPosition>,
  open: OpenPosition[],
  closedNow: Set<string>,
): OpenTransitions {
  const t: OpenTransitions = { opened: [], outOfRange: [], backInRange: [], vanished: [] };
  const openNow = new Set<string>();
  for (const p of open) {
    openNow.add(p.positionAddress);
    const before = prior.get(p.positionAddress);
    if (!before) {
      t.opened.push(p);
      continue;
    }
    // An 'unknown' range on either side says nothing about a crossing.
    if (before.rangeStatus === 'unknown' || p.rangeStatus === 'unknown') continue;
    const wasOut = isOutOfRange(before.rangeStatus);
    const isOut = isOutOfRange(p.rangeStatus);
    if (!wasOut && isOut) t.outOfRange.push(p);
    else if (wasOut && !isOut) t.backInRange.push(p);
  }
  for (const address of prior.keys()) {
    if (!openNow.has(address) && !closedNow.has(address)) t.vanished.push(address);
  }
  return t;
}
