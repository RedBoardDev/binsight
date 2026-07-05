'use client';

import { usePortfolio } from '@/application/stores/portfolio-store';
import { Card, EmptyState } from '@/presentation/ui';

/**
 * Broken-portfolio state: shown when the /state fetch failed AND the live socket has not delivered a
 * payload either, so there is nothing to render but skeletons. Replaces those skeletons with an
 * explicit error + retry, so the user can tell "still loading" from "the feed is down". Shared by the
 * desktop and mobile shells; the retry re-runs the current scope's fetch.
 */
export function PortfolioError() {
  const retry = usePortfolio((s) => s.retry);
  return (
    <Card className="px-6 py-14">
      <EmptyState
        variant="error"
        title="Couldn't load your portfolio"
        hint="The live data feed is unavailable. Check your connection and retry."
        onRetry={retry}
      />
    </Card>
  );
}
