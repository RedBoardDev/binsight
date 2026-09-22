import { type Connection, type ParsedTransactionWithMeta, PublicKey } from '@solana/web3.js';
import type { Logger } from 'pino';
import type { DlmmLeg, SwapFlowRow, WalletFlowRow } from '@/domain/dlmm';
import type { LegRepository, SwapFlowRepository, WalletFlowRepository } from '@/domain/ports';
import { sleep } from '@/util/sleep';
import { withCodePath } from './code-path';
import { decodeDlmmLegs } from './dlmm/dlmm-event-decoder';
import { extractFlowRow, extractSwapRows } from './parsed-tx-adapter';

const SIG_PAGE = 1000; // getSignaturesForAddress hard cap — 1 credit per page, whatever its size
const SIG_RETRIES = 10;
const TX_RETRIES = 4;
// Bound the backfill to a recent window (days) — 0 = full history. Kept as an operator escape hatch
// for onboarding a very old wallet incrementally.
const SINCE_DAYS = Number(process.env.INGEST_SINCE_DAYS) || 0;

export interface WalletTxIngestResult {
  txs: number;
  legs: number;
  flows: number;
  swaps: number;
  complete: boolean;
}

/**
 * The wallet's SINGLE transaction ingest: page `getSignaturesForAddress`, fetch each new transaction
 * ONCE, and fan it out to every consumer that needs it.
 *
 * Before this existed, three ingests paginated the SAME wallet's SAME transactions independently — DLMM
 * legs over RPC, cash-flows over the Helius Enhanced API, swap legs over the Enhanced API again with a
 * `type=SWAP` filter. That cost the transaction three times over and, worse, let the three cursors
 * drift apart. Reading each transaction once and decoding it three ways is both cheaper and structurally
 * incapable of producing an inconsistent view.
 *
 * Cost shape (this is the whole point): a poll with nothing new costs ONE `getSignaturesForAddress` — a
 * single credit — because the cursor short-circuits before any transaction is fetched. Each genuinely
 * new transaction then costs one more credit. The Enhanced API is billed per PAGE (100 credits) whether
 * or not it returns anything new, so the old delta path paid 100–300 credits per trigger to usually
 * learn that nothing had happened.
 *
 * Deliberately NO JSON-RPC batching. A batch is one HTTP request but N billable calls that the provider
 * also counts as N against the per-second ceiling, all landing in the same instant — measured, a batch
 * of 50 is refused outright on a 10 rps key while single calls pace cleanly through the rate limiter.
 * Batching therefore buys nothing but round-trips, at the cost of a burst the limiter cannot smooth.
 *
 * Three modes, by cursor state (unchanged from the ingest this replaces):
 *   - no cursor        → fresh backfill, newest → genesis
 *   - cursor !complete → resume from where it stopped (oldestSig) onward to genesis
 *   - cursor complete  → top-up: newest → the previously-ingested newest
 */
export class WalletTxIngest {
  /** `sleepFn` is injected so retry backoff is instant under test — same idiom as the injected clocks
   *  elsewhere in this layer. Production always gets the real sleep. */
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly conn: Connection,
    private readonly legs: LegRepository,
    private readonly flows: WalletFlowRepository,
    private readonly swaps: SwapFlowRepository,
    private readonly logger: Logger,
    sleepFn: (ms: number) => Promise<void> = sleep,
  ) {
    this.sleep = sleepFn;
  }

  ingest(
    wallet: string,
    opts: { onProgress?: (txs: number) => void; maxPages?: number } = {},
  ): Promise<WalletTxIngestResult> {
    return withCodePath('ingest', () => this.ingestInner(wallet, opts));
  }

  private async ingestInner(
    wallet: string,
    opts: { onProgress?: (txs: number) => void; maxPages?: number } = {},
  ): Promise<WalletTxIngestResult> {
    const maxPages = opts.maxPages ?? Number.POSITIVE_INFINITY;
    const cursor = await this.legs.getCursor(wallet);
    const owner = new PublicKey(wallet);
    const sinceSec = SINCE_DAYS > 0 ? Date.now() / 1000 - SINCE_DAYS * 86_400 : 0;

    const resuming = cursor != null && !cursor.complete;
    const toppingUp = cursor?.complete === true;
    const stopSig = toppingUp ? cursor.newestSig : null;
    let before: string | undefined = resuming ? (cursor.oldestSig ?? undefined) : undefined;

    // The newest signature actually paged THIS run (page[0] of the first successfully persisted page).
    // Whether it becomes the STORED top is decided after the loop: a top-up must reconnect to the old
    // top first — see the cursor block below.
    let runTopSig: string | null = null;
    let oldestSig: string | null = cursor?.oldestSig ?? null;
    let reachedGenesis = false;
    // Run-level: a top-up reconnected to the previously-ingested top. Only then may the stored top move.
    let hitKnownTop = false;
    let pages = 0;
    const totals = { txs: 0, legs: 0, flows: 0, swaps: 0 };

    while (true) {
      const page = await this.signatures(owner, before);
      if (page.length === 0) {
        reachedGenesis = !toppingUp; // an empty page at the bottom = genesis; at the top = nothing new
        break;
      }

      const sigs: string[] = [];
      let pageReachedKnownTop = false;
      for (const s of page) {
        if (stopSig && s.signature === stopSig) {
          pageReachedKnownTop = true;
          break;
        }
        if (s.err) continue; // failed tx — no state change to decode
        sigs.push(s.signature);
      }

      // CRITICAL: a FAILED fetch must NOT delete existing legs. `decodePage` throws if any transaction
      // could not be fetched after retries; we abort the page (no write, no cursor advance) so a re-run
      // resumes cleanly rather than replacing real rows with an empty set.
      let decoded: DecodedPage;
      try {
        decoded = await this.decodePage(wallet, sigs);
      } catch (err) {
        this.logger.error({ err, wallet }, 'wallet tx ingest: page fetch failed — aborting');
        break;
      }

      await this.persist(wallet, sigs, decoded);

      // Record the run's top ONLY AFTER a page is fetched AND persisted. Setting it before the fetch let
      // a failed page move the top PAST un-ingested transactions, which were then never re-fetched — a
      // silent gap that dropped a withdraw and corrupted the position's PnL.
      if (runTopSig === null) runTopSig = page[0]!.signature;
      // Only NOW — after this page's new signatures are persisted — may the reconnect count. Recording it
      // during the scan would let a page whose decode then failed still advance the stored top.
      if (pageReachedKnownTop) hitKnownTop = true;
      totals.txs += decoded.txs;
      totals.legs += decoded.legs.length;
      totals.flows += decoded.flows.length;
      totals.swaps += decoded.swaps.length;
      opts.onProgress?.(totals.txs);

      oldestSig = page[page.length - 1]!.signature;
      before = oldestSig;

      // Bounded window: stop once we've paged past the cutoff — NOT genesis, so `complete` stays false
      // and a later run with a wider window can extend it. blockTime is seconds; null on very old sigs.
      if (sinceSec > 0) {
        const oldestBt = page[page.length - 1]!.blockTime;
        if (oldestBt != null && oldestBt < sinceSec) break;
      }

      if (pageReachedKnownTop) break;
      if (page.length < SIG_PAGE) {
        reachedGenesis = true;
        break;
      }
      if (++pages >= maxPages) break; // bounded run (verification / resume in slices)
    }

    // A top-up may ONLY advance the stored top once it reconnected to the previously-ingested top, or ran
    // clean to genesis. A fetch failure mid-run leaves a gap between the new top and the old one; storing
    // the new top would make every later top-up stop above that gap and NEVER request it — silently losing
    // the DLMM legs inside it. So keep the OLD top and let the next run re-page and close the gap.
    // (Main fixed this as #35 in the per-source DLMM ingest this class replaces; it must not regress here.)
    const topUpCaughtUp = hitKnownTop || reachedGenesis;
    const newestSig = resuming
      ? (cursor?.newestSig ?? null) // a resume never revisits the top
      : toppingUp
        ? topUpCaughtUp
          ? (runTopSig ?? cursor?.newestSig ?? null)
          : (cursor?.newestSig ?? null) // gap left behind → keep the old top, retry next run
        : (runTopSig ?? cursor?.newestSig ?? null); // fresh backfill: the first page's top is the true top

    const complete = reachedGenesis || cursor?.complete === true;
    await this.advanceCursors(wallet, {
      newestSig,
      // A top-up stops above genesis, so it must not clobber the true oldest recorded at backfill.
      oldestSig: toppingUp ? (cursor?.oldestSig ?? null) : oldestSig,
      complete,
    });
    this.logger.info({ wallet, ...totals, complete }, 'wallet tx ingest: done');
    return { ...totals, complete };
  }

  /** One page of signatures, newest-first, with retry. */
  private async signatures(owner: PublicKey, before: string | undefined) {
    let lastErr: unknown;
    for (let i = 0; i < SIG_RETRIES; i++) {
      try {
        return await this.conn.getSignaturesForAddress(owner, { limit: SIG_PAGE, before });
      } catch (err) {
        lastErr = err;
        this.logger.debug({ err, i }, 'getSignaturesForAddress retry');
        await this.sleep(Math.min(15_000, 800 * (i + 1)));
      }
    }
    // CRITICAL: THROW, never return [] — an empty page reads as genesis and would falsely mark the
    // backfill complete mid-history. Throwing aborts the page without advancing the cursor.
    throw lastErr ?? new Error('getSignaturesForAddress failed after retries');
  }

  /**
   * Fetch each signature ONCE and decode it three ways. Sequential single calls: the shared rate
   * limiter paces them, and a per-signature hard failure throws so the caller aborts the page rather
   * than persisting a partial view.
   */
  private async decodePage(wallet: string, sigs: string[]): Promise<DecodedPage> {
    const out: DecodedPage = { txs: 0, legs: [], flows: [], swaps: [] };
    for (const sig of sigs) {
      const tx = await this.parsedTransaction(sig);
      if (!tx) continue; // RPC has no record of it (pruned/unavailable) — nothing to decode
      out.txs++;
      out.legs.push(...decodeDlmmLegs(tx));
      const flow = extractFlowRow(tx, wallet);
      if (flow) out.flows.push(flow);
      out.swaps.push(...extractSwapRows(tx, wallet));
    }
    return out;
  }

  private async parsedTransaction(sig: string): Promise<ParsedTransactionWithMeta | null> {
    let lastErr: unknown;
    for (let i = 0; i < TX_RETRIES; i++) {
      try {
        // maxSupportedTransactionVersion is mandatory: most DLMM txs are v0 and omitting it hard-fails.
        return await this.conn.getParsedTransaction(sig, {
          maxSupportedTransactionVersion: 0,
          commitment: 'confirmed',
        });
      } catch (err) {
        lastErr = err;
        await this.sleep(Math.min(8000, 500 * (i + 1)));
      }
    }
    throw lastErr ?? new Error(`getParsedTransaction failed for ${sig}`);
  }

  /** Persist one page's three products. Legs are replaced per signature (exact re-run); flows and swaps
   *  are insert-if-absent, so re-ingesting a transaction is a no-op for them. */
  private async persist(wallet: string, sigs: string[], page: DecodedPage): Promise<void> {
    await this.legs.replaceForSignatures(wallet, sigs, page.legs);
    if (page.flows.length > 0) await this.flows.upsertFlows(wallet, page.flows);
    if (page.swaps.length > 0) await this.swaps.upsertMany(page.swaps);
  }

  /**
   * Advance all three cursors to the SAME position. They stay separate tables because each still gates
   * something distinct downstream — the swap cursor's `complete` decides whether realized PnL may be
   * computed, the flow cursor's backs the "indexing…" state on the PnL curve — but a single ingest now
   * writes all three from one pagination, so they can no longer disagree about what has been read.
   */
  private async advanceCursors(
    wallet: string,
    cursor: { newestSig: string | null; oldestSig: string | null; complete: boolean },
  ): Promise<void> {
    await this.legs.setCursor(wallet, cursor);
    await this.flows.setCursor(wallet, cursor);
    await this.swaps.setCursor(wallet, cursor);
  }
}

interface DecodedPage {
  txs: number;
  legs: DlmmLeg[];
  flows: WalletFlowRow[];
  swaps: SwapFlowRow[];
}
