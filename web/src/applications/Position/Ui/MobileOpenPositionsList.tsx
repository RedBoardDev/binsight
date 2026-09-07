'use client';

import { usePortfolioFeed } from '@app/applications/Portfolio/Api/portfolioFeed.store';
import { OpenPositionCard } from '@app/applications/Position/Ui/OpenPositionCard';
import { SectionLabel } from '@app/applications/Shared/Ui/SectionLabel';
import { StateMessage } from '@app/applications/Shared/Ui/StateMessage';
import { Skeleton } from '@heroui/react';
import { Layers } from 'lucide-react';

/** Mobile "Positions" tab: open positions as full-width cards instead of a table. */
export const MobileOpenPositionsList = () => {
  const portfolio = usePortfolioFeed((s) => s.portfolio);
  const feedError = usePortfolioFeed((s) => s.error);
  const retryFeed = usePortfolioFeed((s) => s.retry);
  const rows = portfolio?.openByValue ?? [];
  const now = Date.now();

  return (
    <section className="flex flex-col gap-2.5">
      <SectionLabel count={portfolio ? rows.length : undefined}>Open positions</SectionLabel>
      {portfolio == null ? (
        feedError ? (
          <StateMessage
            variant="error"
            title="Couldn't load positions"
            hint="The wallet feed is unreachable."
            onRetry={retryFeed}
          />
        ) : (
          ['a', 'b', 'c'].map((key) => (
            <Skeleton.Root key={key} className="h-[4.75rem] w-full rounded-2xl" />
          ))
        )
      ) : rows.length === 0 ? (
        <StateMessage
          icon={<Layers size={18} />}
          title="No open positions"
          hint="Active Meteora LP positions appear here live."
        />
      ) : (
        rows.map((position) => (
          <OpenPositionCard key={position.address} position={position} now={now} />
        ))
      )}
    </section>
  );
};
