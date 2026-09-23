import type { PositionBins, PositionHistory } from '@binsight/shared';
import {
  buildGpaV2Params,
  buildTokenAccountsByOwnerV2Params,
  coverageIndices,
  DLMM_PROGRAM_ID,
  decodeLbPair,
  decodePosition,
  decodePositionHeader,
  deriveBinArray,
  GPA_V2_PAGE_LIMIT,
  POSITION_V2_DISC,
  POSITION_V2_OWNER_OFFSET,
  parseGpaV2Response,
  parseTokenAccountsByOwnerV2Accounts,
  type RawRpc,
  sleep,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  valuePosition,
} from '@binsight/solana-core';
import { utils } from '@coral-xyz/anchor';
import {
  type AccountInfo,
  type Connection,
  type GetProgramAccountsFilter,
  PublicKey,
} from '@solana/web3.js';
import type { OnchainPositionValue, OnchainWalletSnapshot, SnapshotPlan } from '@/domain/dlmm';
import type { OnchainDlmmGateway as OnchainDlmmGatewayPort } from '@/domain/ports';
import { binsFromAccounts, fetchPositionBins, type PositionBinsSource } from './position-detail';
import { fetchPositionHistory } from './position-history';

const TOKEN_PROGRAM = new PublicKey(TOKEN_PROGRAM_ID);
const TOKEN_2022_PROGRAM = new PublicKey(TOKEN_2022_PROGRAM_ID);
const GMA_CHUNK = 100;
/** SPL token-account layout: mint @ 0 (32B), owner @ 32 (32B), amount @ 64 (u64 LE). Token-2022 keeps
 *  the same 165-byte base before its extensions, so one decoder serves both. */
const TOKEN_ACCOUNT_MIN_LEN = 72;
const MIN_CONTEXT_RETRIES = 3;
/**
 * How long an idle-token read stays reusable. Position amounts and fees move on their own every block,
 * which is why the snapshot cadence is 10s; a wallet's token BALANCES only move when it transacts, and
 * every transaction the wallet signs invalidates this cache through `invalidateIdle`. Re-reading hundreds of
 * token accounts on every cadence tick multiplied the snapshot's cost by the number of chunks they
 * span (measured: 301 accounts → 5 getMultipleAccounts instead of 1, every 10s, per wallet).
 *
 * The TTL is only the backstop for a change no event announced. It bounds how stale the idle side can
 * be; the position side stays exact on every tick.
 */
const IDLE_TTL_MS = 60_000;
const HISTORY_TTL_MS = 60_000; // open positions may still accrue events; closed are immutable
const HISTORY_MAX = 5000; // bound the cache: closed entries have no TTL, so cap total + FIFO-evict
// How old a snapshot's accounts may be and still serve a position's bin histogram. The snapshot refreshes
// an open position every 10 s; this covers a skipped or slow tick without ever serving a stale chart.
const BINS_SOURCE_MAX_AGE_MS = 30_000;

/** base58 encode of a byte array (for getProgramAccounts memcmp filters). */
const minimalBase58 = (b: Uint8Array): string => utils.bytes.bs58.encode(b);

const u64le = (b: Uint8Array, o: number): bigint => {
  let r = 0n;
  for (let i = 7; i >= 0; i--) r = (r << 8n) | BigInt(b[o + i]!);
  return r;
};

/**
 * 100%-on-chain DLMM wallet snapshot. Discovers a wallet's positions (getProgramAccountsV2 owner@40),
 * then values every position + reads native SOL + stable ATAs in ONE pinned getMultipleAccounts pass
 * so the whole total is internally consistent (no two-clock double-counting). Validated byte-exact
 * vs the Meteora datapi on live positions.
 */
export class OnchainDlmmGateway implements OnchainDlmmGatewayPort {
  private readonly decimalsCache = new Map<string, number>();
  private readonly historyCache = new Map<
    string,
    { hist: PositionHistory; at: number; closed: boolean }
  >();

  // Raw JSON-RPC caller for methods web3.js's Connection has no typed helper for (getProgramAccountsV2).
  // Defaults to the Connection's internal `_rpcRequest`, which routes through the SAME fetch middleware as
  // every other call — so the rate-limiter + CreditMeter still meter it (method 'getProgramAccountsV2' →
  // 1 credit). Injectable so the gateway is unit-tested with a spy (no network).
  private readonly rawRpc: RawRpc;
  /** position → the accounts its last snapshot valued it from, with when. See positionBins. */
  private readonly binsSource = new Map<string, PositionBinsSource & { at: number }>();
  /** owner → last idle-token read. See {@link IDLE_TTL_MS}. */
  private readonly idleCache = new Map<
    string,
    { tokens: OnchainWalletSnapshot['idleTokens']; at: number }
  >();

  constructor(
    private readonly conn: Connection,
    rawRpc?: RawRpc,
  ) {
    this.rawRpc =
      rawRpc ??
      ((method, params) =>
        (conn as unknown as { _rpcRequest(m: string, a: unknown[]): Promise<unknown> })._rpcRequest(
          method,
          params,
        ));
  }

  /**
   * Drop a wallet's cached idle-token read so the next snapshot re-reads its balances. The engine calls
   * this on every transaction the wallet makes (DLMM or not) and whenever an ingest finds new ones.
   */
  invalidateIdle(ownerStr: string): void {
    this.idleCache.delete(ownerStr);
  }

  /**
   * getProgramAccountsV2 → just the position pubkeys for this owner (pubkeys only, cheap). Paginates the
   * 1-credit V2 method (the legacy getProgramAccounts was 10 credits) over the SAME metered Connection,
   * with the identical owner-memcmp + position-discriminator filters → byte-identical result set.
   *
   * DEFERRED (no-miss): `changedSinceSlot` (incremental discovery) is supported by the builder but NOT
   * wired here — a delta-only discovery would drop unchanged-but-still-open positions unless merged
   * against a durable cached set. We do a FULL paginated discovery (gated by the engine's Layer-A so it
   * only runs on a position-SET change), keeping discovery results identical to the legacy path.
   */
  private async discover(owner: string): Promise<PublicKey[]> {
    const filters: GetProgramAccountsFilter[] = [
      { memcmp: { offset: 0, bytes: minimalBase58(Uint8Array.from(POSITION_V2_DISC)) } },
      { memcmp: { offset: POSITION_V2_OWNER_OFFSET, bytes: owner } },
    ];
    const programId = DLMM_PROGRAM_ID;
    const pubkeys: PublicKey[] = [];
    let paginationKey: string | null = null;
    do {
      const params = buildGpaV2Params(programId, {
        filters,
        dataSlice: { offset: 0, length: 0 },
        commitment: 'confirmed',
        limit: GPA_V2_PAGE_LIMIT,
        paginationKey,
      });
      const page = parseGpaV2Response(await this.rawRpc('getProgramAccountsV2', params));
      for (const pk of page.pubkeys) pubkeys.push(new PublicKey(pk));
      paginationKey = page.paginationKey;
    } while (paginationKey !== null);
    return pubkeys;
  }

  /**
   * Read every classic-SPL and Token-2022 account the wallet controls, WITH the bytes we need, in one
   * call per token program. `dataSlice` 0..72 covers the mint (0..32) and the amount (64..72).
   *
   * This deliberately does NOT discover pubkeys and then read them with getMultipleAccounts: hundreds
   * of token accounts would add several 100-key reads to every 10 s snapshot. One call per token program
   * returns the same bytes.
   */
  private async readTokenAccounts(owner: string): Promise<OnchainWalletSnapshot['idleTokens']> {
    const out: OnchainWalletSnapshot['idleTokens'] = [];
    const heldMints = new Map<string, PublicKey>();
    const decoded: { key: string; mint: PublicKey; amount: bigint; token2022: boolean }[] = [];

    for (const programId of [TOKEN_PROGRAM, TOKEN_2022_PROGRAM]) {
      let paginationKey: string | null = null;
      do {
        const params = buildTokenAccountsByOwnerV2Params(owner, programId.toBase58(), {
          dataSlice: { offset: 0, length: TOKEN_ACCOUNT_MIN_LEN },
          commitment: 'confirmed',
          limit: GPA_V2_PAGE_LIMIT,
          paginationKey,
        });
        const page = parseTokenAccountsByOwnerV2Accounts(
          await this.rawRpc('getTokenAccountsByOwnerV2', params),
        );
        for (const account of page.accounts) {
          const data = Buffer.from(account.data, 'base64');
          if (data.length < TOKEN_ACCOUNT_MIN_LEN) continue;
          const amount = u64le(data, 64);
          if (amount <= 0n) continue; // a zero-balance account holds nothing to value
          const mint = new PublicKey(data.subarray(0, 32));
          heldMints.set(mint.toBase58(), mint);
          decoded.push({
            key: account.pubkey,
            mint,
            amount,
            token2022: account.owner === TOKEN_2022_PROGRAM_ID,
          });
        }
        paginationKey = page.paginationKey;
      } while (paginationKey !== null);
    }

    // One batched pass for the mints not already resolved from the pools.
    await this.decimalsFor([...heldMints.values()]);
    for (const { key, mint, amount, token2022 } of decoded) {
      const mintStr = mint.toBase58();
      out.push({
        accountAddress: key,
        tokenProgram: token2022 ? 'token2022' : 'spl',
        mint: mintStr,
        amount,
        decimals: this.decimalsCache.get(mintStr) ?? 0,
      });
    }
    return out;
  }

  /** Chunked getMultipleAccounts pinned to one target slot. Returns infos in key order + slot skew. */
  private async fetchAtSlot(
    keys: PublicKey[],
  ): Promise<{ slot: number; skew: number; infos: (AccountInfo<Buffer> | null)[] }> {
    const infos: (AccountInfo<Buffer> | null)[] = new Array(keys.length).fill(null);
    if (keys.length === 0) return { slot: 0, skew: 0, infos };
    let target: number | undefined;
    let minSlot = Number.POSITIVE_INFINITY;
    let maxSlot = 0;
    for (let i = 0; i < keys.length; i += GMA_CHUNK) {
      const chunk = keys.slice(i, i + GMA_CHUNK);
      // Exactly ONE read per chunk. `minContextSlot` is a FLOOR, not an exact slot: pinning every later
      // chunk to the first one's slot keeps them from reading OLDER state, which is all it can do. A
      // "re-converge" loop used to re-read a chunk that landed past the floor, bumping the floor each time
      // — but the first chunk was never re-read, and a floor cannot go back, so the loop could never
      // align the chunks. It only chased a newer slot, WIDENING the very skew it meant to close, and paid
      // a getMultipleAccounts per turn: ~40% of the snapshot's standing cost for no consistency at all.
      // The skew that remains is reported below and gates freshness exactly as before.
      const res = await this.readChunkAtFloor(chunk, target);
      if (target === undefined) target = res.context.slot;
      res.value.forEach((v, j) => {
        infos[i + j] = v;
      });
      minSlot = Math.min(minSlot, res.context.slot);
      maxSlot = Math.max(maxSlot, res.context.slot);
    }
    return { slot: maxSlot, skew: maxSlot - minSlot, infos };
  }

  /** One pinned getMultipleAccounts, retrying a transient lag behind the requested floor. */
  private async readChunkAtFloor(
    chunk: PublicKey[],
    minContextSlot: number | undefined,
  ): Promise<Awaited<ReturnType<Connection['getMultipleAccountsInfoAndContext']>>> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.conn.getMultipleAccountsInfoAndContext(chunk, {
          commitment: 'confirmed',
          minContextSlot,
        });
      } catch (error) {
        // A load-balanced RPC node may briefly lag behind the previous chunk's context. Helius reports
        // that as code -32016; retry the SAME floor after a short wait. Every other error stays fatal,
        // so an incomplete inventory can never be mistaken for a successful read.
        if ((error as { code?: number }).code !== -32016 || attempt === MIN_CONTEXT_RETRIES)
          throw error;
        await sleep(100 * (attempt + 1));
      }
    }
  }

  private async decimalsFor(mints: PublicKey[]): Promise<void> {
    const missing = mints.filter((m) => !this.decimalsCache.has(m.toBase58()));
    if (missing.length === 0) return;
    for (let i = 0; i < missing.length; i += GMA_CHUNK) {
      const chunk = missing.slice(i, i + GMA_CHUNK);
      const infos = await this.conn.getMultipleAccountsInfo(chunk, 'confirmed');
      infos.forEach((info, j) => {
        // SPL Mint: decimals @ offset 44 (works for Token & Token-2022 base layout). A NULL info is a
        // transient RPC miss (429 / not-yet-visible mint) — do NOT cache it: a one-off blip would pin
        // this mint's decimals at 0 forever and mis-value every later residual conversion. Leaving it
        // unset lets the next call retry; until then decimalsOf falls back to 0 for this call only.
        // A NULL info is a transient RPC miss and stays uncached (see above). An account neither token
        // program owns is not a mint at all: byte 44 would be meaningless, so reject it outright.
        if (!info) return;
        if (!info.owner.equals(TOKEN_PROGRAM) && !info.owner.equals(TOKEN_2022_PROGRAM)) return;
        this.decimalsCache.set(chunk[j]!.toBase58(), info.data[44]!);
      });
    }
  }

  /** Token decimals for one mint (cached). Converts a UI residual amount to raw for a Jupiter quote. */
  async decimalsOf(mint: string): Promise<number> {
    await this.decimalsFor([new PublicKey(mint)]);
    return this.decimalsCache.get(mint) ?? 0;
  }

  /** Token decimals for MANY mints in one batched pass (≤100 per getMultipleAccounts, cached). The
   *  realized-PnL engine needs every traded mint's decimals; fetching them one-by-one cost ~1 RPC per
   *  mint (~1600 on a cold wallet). This batches them via the shared `decimalsFor` so a cold pass is
   *  ~ceil(mints/100) calls and a warm one is 0. Missing mints default to 0 (same as `decimalsOf`). */
  async decimalsOfMany(mints: string[]): Promise<Map<string, number>> {
    await this.decimalsFor(mints.map((m) => new PublicKey(m)));
    return new Map(mints.map((m) => [m, this.decimalsCache.get(m) ?? 0]));
  }

  /**
   * Per-bin liquidity distribution of one open position (for the Price-Bin histogram).
   *
   * Served from the last wallet snapshot when it is recent: that pinned pass already read this exact
   * position, its pool and every bin array it covers. Re-reading them per request was the single largest
   * cost with the macOS panel open — it polls each open card's bins every ~100 s, measured at 134 reads
   * in 10 minutes across 23 positions, ~25 credits/min — for data the 10 s snapshot had just fetched.
   * A snapshot-sourced histogram is exactly as fresh as every other figure on screen, which comes from
   * the same snapshot. A position the snapshot does not cover (or a stale one) still reads on demand.
   */
  positionBins(positionAddress: string): Promise<PositionBins | null> {
    const src = this.binsSource.get(positionAddress);
    if (src && Date.now() - src.at < BINS_SOURCE_MAX_AGE_MS) {
      return binsFromAccounts(src, (m) => this.decimalsOf(m));
    }
    return fetchPositionBins(this.conn, (m) => this.decimalsOf(m), positionAddress);
  }

  /** On-chain event timeline of a position (History drawer). Cached: closed forever, open 60s. */
  async positionHistory(positionAddress: string): Promise<PositionHistory | null> {
    const hit = this.historyCache.get(positionAddress);
    if (hit && (hit.closed || Date.now() - hit.at < HISTORY_TTL_MS)) return hit.hist;
    const hist = await fetchPositionHistory(this.conn, (m) => this.decimalsOf(m), positionAddress);
    if (hist) {
      const closed = hist.events.some((e) => e.kind === 'close');
      // Bound the (otherwise unbounded) cache: closed histories carry no TTL, so cap the total and
      // FIFO-evict the oldest. An evicted entry is simply re-fetched on its next miss (immutable).
      if (this.historyCache.size >= HISTORY_MAX && !this.historyCache.has(positionAddress)) {
        const oldest = this.historyCache.keys().next().value;
        if (oldest !== undefined) this.historyCache.delete(oldest);
      }
      this.historyCache.set(positionAddress, { hist, at: Date.now(), closed });
    }
    return hist;
  }

  async snapshotWallet(
    ownerStr: string,
    cachedPlan?: SnapshotPlan,
  ): Promise<OnchainWalletSnapshot & { plan: SnapshotPlan }> {
    const owner = new PublicKey(ownerStr);
    // Layer A: reuse a cached discovery plan when the position set/ranges haven't changed (the engine
    // invalidates it on WS open/close/add/remove), skipping the getProgramAccountsV2 discovery AND the
    // round-1 header read. The round-2 valuation below is byte-identical either way.
    const plan = cachedPlan ?? (await this.buildPlan(ownerStr));
    const { positionKeys, lbPairByPos, coverageByPos, lbPairKeys, binArrayKeys, binArrayMeta } =
      plan;

    // Round 2: ONE pinned pass — positions + lbPairs + binArrays + wallet (native). The wallet's token
    // accounts are read SEPARATELY (see readTokenAccounts): folding them in made every snapshot a
    // multi-hundred-reservation burst on the live rate-limiter lane.
    const allKeys = [...positionKeys, ...lbPairKeys, ...binArrayKeys, owner];
    const { slot, skew, infos } = await this.fetchAtSlot(allKeys);

    const nPos = positionKeys.length;
    const nLb = lbPairKeys.length;
    const nBa = binArrayKeys.length;
    const posInfos = infos.slice(0, nPos);
    const lbInfos = infos.slice(nPos, nPos + nLb);
    const baInfos = infos.slice(nPos + nLb, nPos + nLb + nBa);
    const walletInfo = infos[nPos + nLb + nBa];

    const lbByKey = new Map<string, ReturnType<typeof decodeLbPair>>();
    const lbRawByKey = new Map<string, Uint8Array>();
    lbPairKeys.forEach((k, i) => {
      const info = lbInfos[i];
      if (!info) return;
      lbByKey.set(k.toBase58(), decodeLbPair(info.data));
      lbRawByKey.set(k.toBase58(), info.data);
    });
    // Positions that left the snapshot (closed, or another wallet's that stopped refreshing) age out here,
    // so the per-position cache stays bounded by what is currently open.
    const now = Date.now();
    for (const [addr, src] of this.binsSource) {
      if (now - src.at >= BINS_SOURCE_MAX_AGE_MS) this.binsSource.delete(addr);
    }
    const baByMeta = new Map<string, Uint8Array>();
    binArrayMeta.forEach((m, i) => {
      const info = baInfos[i];
      if (info) baByMeta.set(`${m.lbPair}:${m.index}`, info.data);
    });

    // decimals for all involved mints
    const mintSet = new Map<string, PublicKey>();
    for (const lb of lbByKey.values()) {
      mintSet.set(lb.tokenXMint.toBase58(), lb.tokenXMint);
      mintSet.set(lb.tokenYMint.toBase58(), lb.tokenYMint);
    }
    await this.decimalsFor([...mintSet.values()]);

    const positions: OnchainPositionValue[] = [];
    // Track whether the chain read fully covered every held position. An under/over-stated snapshot
    // (missing pool data, unfetched bin-array, unknown decimals) must NOT be persisted as a real Net
    // Worth point — it surfaces as `complete: false` → freshness 'syncing' → skipped by the recorder.
    let complete = true;
    // A live position this read could not value. It is still OPEN — dropping it from the snapshot
    // would read as a close to the projection, so the snapshot says it is partial instead.
    let positionsComplete = true;
    positionKeys.forEach((pk, i) => {
      const info = posInfos[i];
      if (!info) return; // position account absent → closed between rounds (benign; not a data miss)
      const lbPair = lbPairByPos.get(pk.toBase58());
      const lb = lbPair && lbByKey.get(lbPair.toBase58());
      if (!lbPair || !lb) {
        // The position exists on-chain but its pool (lbPair) data wasn't read: its value would be
        // dropped, deflating the total, and the position itself would look closed.
        complete = false;
        positionsComplete = false;
        return;
      }
      const pos = decodePosition(info.data);
      const baMap = new Map<number, Uint8Array | null>();
      for (const idx of coverageByPos.get(pk.toBase58()) ?? []) {
        baMap.set(idx, baByMeta.get(`${lbPair.toBase58()}:${idx}`) ?? null);
      }
      const v = valuePosition(pos, baMap);
      if (!v.complete) complete = false; // a share>0 bin's bin-array was absent → amounts under-counted
      // Keep the exact accounts this position was just valued from, so the bin histogram is served from
      // memory instead of re-reading them — see positionBins.
      const lbRaw = lbRawByKey.get(lbPair.toBase58());
      if (lbRaw) {
        this.binsSource.set(pk.toBase58(), {
          position: info.data,
          lbPair: lbRaw,
          binArrays: baMap,
          slot,
          at: now,
        });
      }
      const dX = this.decimalsCache.get(lb.tokenXMint.toBase58());
      const dY = this.decimalsCache.get(lb.tokenYMint.toBase58());
      // R23: a NULL decimals (transient RPC miss — deliberately not cached) makes ui(amount,0) =
      // Number(amount), inflating a 6/9-dp token by 10^6–10^9. Flag incomplete instead of persisting
      // the mis-scaled amount; the next snapshot retries the mint and resolves it.
      if (dX === undefined || dY === undefined) complete = false;
      positions.push({
        positionAddress: pk.toBase58(),
        lbPair: lbPair.toBase58(),
        tokenXMint: lb.tokenXMint.toBase58(),
        tokenYMint: lb.tokenYMint.toBase58(),
        amountX: v.amountX,
        amountY: v.amountY,
        feeX: v.feeX,
        feeY: v.feeY,
        decimalsX: dX ?? 0,
        decimalsY: dY ?? 0,
        activeId: lb.activeId,
        binStep: lb.binStep,
        lowerBinId: pos.lowerBinId,
        upperBinId: pos.upperBinId,
        lamports: BigInt(info.lamports),
      });
    });

    // Idle balances: served from cache unless the wallet transacted (invalidateIdle) or the TTL
    // lapsed. Two RPC calls when it does refresh, not a pinned multi-chunk read.
    const cachedIdle = this.idleCache.get(ownerStr);
    let idleTokens: OnchainWalletSnapshot['idleTokens'];
    if (cachedIdle != null && Date.now() - cachedIdle.at < IDLE_TTL_MS) {
      idleTokens = cachedIdle.tokens;
    } else {
      idleTokens = await this.readTokenAccounts(ownerStr);
      // A mint whose decimals would not decode mis-scales the amount by up to 10^9. Flag the snapshot
      // incomplete and do NOT cache it, so the next tick retries instead of re-serving it for a TTL.
      const idleComplete = idleTokens.every((t) => this.decimalsCache.has(t.mint));
      if (idleComplete) this.idleCache.set(ownerStr, { tokens: idleTokens, at: Date.now() });
      else complete = false;
    }

    return {
      owner: ownerStr,
      slot,
      slotSkew: skew,
      nativeLamports: walletInfo ? BigInt(walletInfo.lamports) : 0n,
      idleTokens,
      positions,
      complete,
      positionsComplete,
      plan,
    };
  }

  /** Discovery (getProgramAccountsV2) + round-1 header read → the cacheable snapshot plan. */
  private async buildPlan(ownerStr: string): Promise<SnapshotPlan> {
    const positionKeys = await this.discover(ownerStr);
    const headers = (await this.fetchAtSlot(positionKeys)).infos;
    const lbPairByPos = new Map<string, PublicKey>();
    const coverageByPos = new Map<string, number[]>();
    const lbPairSet = new Map<string, PublicKey>();
    const binArrayKeys: PublicKey[] = [];
    const binArrayMeta: { lbPair: string; index: number }[] = [];
    // Positions in the same pool share bin arrays: read each one once.
    const seenBinArrays = new Set<string>();
    positionKeys.forEach((pk, i) => {
      const info = headers[i];
      if (!info) return;
      const h = decodePositionHeader(info.data);
      const lb = h.lbPair.toBase58();
      lbPairByPos.set(pk.toBase58(), h.lbPair);
      lbPairSet.set(lb, h.lbPair);
      const idxs = coverageIndices(h.lowerBinId, h.upperBinId);
      coverageByPos.set(pk.toBase58(), idxs);
      for (const idx of idxs) {
        const key = `${lb}:${idx}`;
        if (seenBinArrays.has(key)) continue;
        seenBinArrays.add(key);
        binArrayKeys.push(deriveBinArray(h.lbPair, idx));
        binArrayMeta.push({ lbPair: lb, index: idx });
      }
    });
    return {
      positionKeys,
      lbPairByPos,
      coverageByPos,
      lbPairKeys: [...lbPairSet.values()],
      binArrayKeys,
      binArrayMeta,
    };
  }
}
