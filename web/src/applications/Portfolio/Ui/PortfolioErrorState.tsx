'use client';

import { usePortfolioFeed } from '@app/applications/Portfolio/Api/portfolioFeed.store';
import { StateMessage } from '@app/applications/Shared/Ui/StateMessage';
import { Card } from '@heroui/react';

/**
 * Broken-portfolio state: the /state fetch failed AND the live socket has not delivered a payload
 * either, so there is nothing to render but skeletons. Replaces those skeletons with an explicit
 * error + retry, so the user can tell "still loading" from "the feed is down". The retry re-runs the
 * current scope's fetch.
 */
export const PortfolioErrorState = () => {
  const retry = usePortfolioFeed((s) => s.retry);

  return (
    <Card.Root className="p-0">
      <Card.Content>
        <StateMessage
          hint="The live data feed is unavailable. Check your connection and retry."
          onRetry={retry}
          title="Couldn't load your portfolio"
          variant="error"
        />
      </Card.Content>
    </Card.Root>
  );
};
