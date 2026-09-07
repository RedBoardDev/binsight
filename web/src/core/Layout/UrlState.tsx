'use client';

import { usePortfolioFeed } from '@app/applications/Portfolio/Api/portfolioFeed.store';
import { fetchClosedPosition } from '@app/applications/Position/Api/usePositions.api';
import { useWallets } from '@app/applications/Wallet/Api/useWallets.api';
import { useUi } from '@app/core/stores/uiStore';
import { usePathname, useSearchParams } from 'next/navigation';
import { useEffect, useRef } from 'react';

const SCOPE_KEY = 'binsight-scope';

/**
 * Keeps the URL (`?address`, `?positionId`), localStorage (last scope) and the stores in sync, so a
 * link is shareable, bookmarkable and deep-linkable.
 *
 * Reads are guarded by refs so they run once; writes never feed back into the read (nothing depends
 * on `useSearchParams` after mount), which is what keeps the whole thing loop-free.
 */
export const UrlState = () => {
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const setScope = usePortfolioFeed((s) => s.setScope);
  const scope = usePortfolioFeed((s) => s.scope);
  const portfolio = usePortfolioFeed((s) => s.portfolio);
  const selected = useUi((s) => s.selected);
  const select = useUi((s) => s.select);
  const { data: wallets } = useWallets();

  const pendingPosition = useRef<string | null>(null);
  const firstWrite = useRef(true);

  // biome-ignore lint/correctness/useExhaustiveDependencies: a deliberate once-on-mount restore.
  useEffect(() => {
    let stored: string | null = null;
    try {
      stored = localStorage.getItem(SCOPE_KEY);
    } catch {}
    const address = searchParams.get('address') ?? stored;
    if (address && address !== 'all') setScope(address);
    const position = searchParams.get('positionId');
    if (position) pendingPosition.current = position;
  }, []);

  // Resolve a pending `?positionId` once data is available: an open position from the live feed,
  // otherwise a single closed fetch. Best-effort — a stale link just opens nothing.
  useEffect(() => {
    const address = pendingPosition.current;
    if (!address || !portfolio) return;
    const open = portfolio.open.find((p) => p.address === address);
    pendingPosition.current = null;
    if (open) {
      select({ address, pair: open.pair, open: true });
      return;
    }
    fetchClosedPosition(address)
      .then((res) => {
        if (res.closed) {
          select({
            address,
            pair: `${res.closed.tokenX}/${res.closed.tokenY}`,
            open: false,
            closed: res.closed,
          });
        }
      })
      .catch(() => {});
  }, [portfolio, select]);

  // Drop a stale `?address` that is not one of the configured wallets.
  useEffect(() => {
    if (!wallets) return;
    if (scope !== 'all' && !wallets.some((w) => w.address === scope)) setScope('all');
  }, [wallets, scope, setScope]);

  // Reflect scope and the open panel into the URL. Skip the very first run so the restore above
  // reads the incoming URL before we write, and hold off while a deep-linked position is still
  // resolving (otherwise its `?positionId` is stripped before the panel opens).
  useEffect(() => {
    if (firstWrite.current) {
      firstWrite.current = false;
      return;
    }
    if (pendingPosition.current) return;
    const params = new URLSearchParams();
    if (scope !== 'all') params.set('address', scope);
    if (selected) params.set('positionId', selected.address);
    const query = params.toString();
    window.history.replaceState(null, '', query ? `${pathname}?${query}` : pathname);
  }, [scope, selected, pathname]);

  useEffect(() => {
    try {
      if (scope === 'all') localStorage.removeItem(SCOPE_KEY);
      else localStorage.setItem(SCOPE_KEY, scope);
    } catch {}
  }, [scope]);

  return null;
};
