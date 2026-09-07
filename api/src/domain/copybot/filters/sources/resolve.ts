/**
 * Copy-bot · PURE orchestration of the filters' external data: ONE fetch per NEEDED source (grouped, not
 * per-metric), cache-first, bounded by a hard timeout. A miss/timeout ⇒ that source's fields are omitted (the
 * enabled filters then skip). Returns ONLY external fields — the caller merges local (`openTokenMints`) +
 * leader-shape (`priceRangePercent`). Providers are injected ⇒ no direct I/O here. Spec: `19` §5.
 */
import type { TtlCache } from '../../ttl-cache';
import type { DataSource, FilterContext } from '../filter';
import { snapshotToContext } from './snapshot';
import type { MintExtensionsProvider, TokenSnapshot, TokenSnapshotProvider } from './source';

const JUPITER_TOKEN: DataSource = 'jupiter-token';
const MINT_EXTENSIONS: DataSource = 'mint-extensions';

/** Concrete providers + caches the resolver orchestrates (one entry per external source). */
export interface ResolveDeps {
  jupiterToken: TokenSnapshotProvider;
  snapshotCache: TtlCache<TokenSnapshot>;
  /** Token-2022 `TransferFeeConfig` presence for a mint (source: `mint-extensions`, finding #105). */
  mintExtensions: MintExtensionsProvider;
  /** Per-mint transfer-fee cache — long-lived: the extension set is immutable ⇒ one read per mint per process. */
  transferFeeCache: TtlCache<boolean>;
}

/**
 * Resolve the externally-sourced `FilterContext` fields for `mint`, given the sources the config needs. Each
 * NEEDED source is fetched at most once (cache-first) and the sources run concurrently — off the open hot path.
 */
export async function resolveFilterContext(
  mint: string | null,
  sources: ReadonlySet<DataSource>,
  deps: ResolveDeps,
  opts: { nowMs: number; timeoutMs: number },
): Promise<Partial<FilterContext>> {
  if (!mint) return {};
  const [tokenData, feeData] = await Promise.all([
    resolveJupiterToken(mint, sources, deps, opts),
    resolveTransferFee(mint, sources, deps, opts),
  ]);
  return { ...tokenData, ...feeData };
}

/** jupiter-token source → the numeric/authority snapshot fields (miss/timeout ⇒ omitted, enabled filters skip). */
async function resolveJupiterToken(
  mint: string,
  sources: ReadonlySet<DataSource>,
  deps: ResolveDeps,
  opts: { nowMs: number; timeoutMs: number },
): Promise<Partial<FilterContext>> {
  if (!sources.has(JUPITER_TOKEN)) return {};
  const cached = deps.snapshotCache.get(mint, opts.nowMs);
  const snapshot = cached ?? (await settleWithin(deps.jupiterToken(mint), opts.timeoutMs));
  if (!snapshot) return {};
  if (!cached) deps.snapshotCache.set(mint, snapshot, opts.nowMs);
  return snapshotToContext(snapshot, opts.nowMs);
}

/**
 * mint-extensions source → `hasTransferFee`. A confirmed read (true/false) sets the flag; an UNREADABLE mint
 * (provider null / timeout) leaves it UNSET so the brick fails closed (`transfer_fee_unavailable`). `false` is a
 * valid cached value — `??` and `=== undefined` preserve it — so the immutable set is read at most once per mint.
 */
async function resolveTransferFee(
  mint: string,
  sources: ReadonlySet<DataSource>,
  deps: ResolveDeps,
  opts: { nowMs: number; timeoutMs: number },
): Promise<Partial<FilterContext>> {
  if (!sources.has(MINT_EXTENSIONS)) return {};
  const cached = deps.transferFeeCache.get(mint, opts.nowMs);
  const hasTransferFee = cached ?? (await settleWithin(deps.mintExtensions(mint), opts.timeoutMs));
  if (hasTransferFee === null) return {}; // unreadable ⇒ leave unresolved so the brick fails closed
  if (cached === undefined) deps.transferFeeCache.set(mint, hasTransferFee, opts.nowMs);
  return { hasTransferFee };
}

/** Resolve to `null` on timeout OR rejection — never throws (keeps filters off the open's critical path). */
function settleWithin<T>(promise: Promise<T>, timeoutMs: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      },
    );
  });
}
