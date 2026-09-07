'use client';

import { usePortfolioFeed } from '@app/applications/Portfolio/Api/portfolioFeed.store';
import { useWallets } from '@app/applications/Wallet/Api/useWallets.api';
import { Alert } from '@heroui/react';

/**
 * Shown while a freshly-added wallet is still backfilling its on-chain history, so the user sees
 * clear progress instead of an empty/zeroed view. Scoped: only appears for the wallet(s) in view.
 */
export const IndexingBanner = () => {
  const scope = usePortfolioFeed((s) => s.scope);
  const { data } = useWallets();

  const indexing = (data ?? []).filter((wallet) => wallet.ready === false);
  if (indexing.length === 0) return null;
  // For a single-wallet scope, only surface it when THAT wallet is the one indexing.
  if (scope !== 'all' && !indexing.some((wallet) => wallet.address === scope)) return null;

  const current = scope !== 'all' ? indexing.find((wallet) => wallet.address === scope) : undefined;
  const txs = current?.indexedTxs ?? indexing.reduce((sum, w) => sum + (w.indexedTxs ?? 0), 0);
  const title = current
    ? "Indexing this wallet's on-chain history…"
    : `Indexing ${indexing.length} wallet${indexing.length > 1 ? 's' : ''}…`;

  return (
    <Alert.Root status="accent">
      <Alert.Indicator>
        <span className="size-2 animate-pulse rounded-full bg-accent" />
      </Alert.Indicator>
      <Alert.Content>
        <Alert.Title>{title}</Alert.Title>
        <Alert.Description>
          {txs > 0 ? `${txs.toLocaleString('en-US')} transactions processed` : 'Reading the chain…'}{' '}
          · runs once, then stays live.
        </Alert.Description>
      </Alert.Content>
    </Alert.Root>
  );
};
