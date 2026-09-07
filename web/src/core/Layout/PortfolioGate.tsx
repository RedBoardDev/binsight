'use client';

import { usePortfolioFeed } from '@app/applications/Portfolio/Api/portfolioFeed.store';
import { PortfolioErrorState } from '@app/applications/Portfolio/Ui/PortfolioErrorState';
import { useWallets } from '@app/applications/Wallet/Api/useWallets.api';
import { EmptyWalletsState } from '@app/applications/Wallet/Ui/EmptyWalletsState';
import type { ReactNode } from 'react';

interface PortfolioGateProps {
  children: ReactNode;
}

/**
 * The two states that replace the whole dashboard rather than a part of it: an account with no
 * wallets yet, and a feed that is broken rather than merely slow. Shared by both shells so the phone
 * and the desktop can never disagree about which one to show.
 */
export const PortfolioGate = ({ children }: PortfolioGateProps) => {
  const { data: wallets, isSuccess } = useWallets();
  // Broken feed: the /state fetch failed AND no socket payload has landed, so there is nothing to
  // render but skeletons. Show retry instead, so "still loading" never looks like "the feed is down".
  const portfolioBroken = usePortfolioFeed((s) => s.error && s.portfolio === null);

  if (isSuccess && wallets.length === 0) return <EmptyWalletsState />;
  if (portfolioBroken) return <PortfolioErrorState />;
  return children;
};
