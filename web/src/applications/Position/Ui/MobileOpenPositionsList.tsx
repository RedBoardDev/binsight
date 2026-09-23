'use client';

import { usePortfolioFeed } from '@app/applications/Portfolio/Api/portfolioFeed.store';
import { OpenPositionCard } from '@app/applications/Position/Ui/OpenPositionCard';
import { OpenPositionsState } from '@app/applications/Position/Ui/PositionListState';
import { SectionLabel } from '@app/applications/Shared/Ui/SectionLabel';
import { Skeleton } from '@heroui/react';

/** Mobile "Positions" tab: open positions as full-width cards instead of a table. */
export const MobileOpenPositionsList = () => {
  const portfolio = usePortfolioFeed((s) => s.portfolio);
  const rows = portfolio?.openByValue ?? [];
  const now = Date.now();

  return (
    <section className="flex flex-col gap-2.5">
      <SectionLabel count={portfolio ? rows.length : undefined}>Open positions</SectionLabel>
      <OpenPositionsState
        skeleton={['a', 'b', 'c'].map((key) => (
          <Skeleton.Root key={key} className="h-[4.75rem] w-full rounded-2xl" />
        ))}
      >
        {rows.map((position) => (
          <OpenPositionCard key={position.address} position={position} now={now} />
        ))}
      </OpenPositionsState>
    </section>
  );
};
