'use client';

import { ClosedPositionCard } from '@app/applications/Position/Ui/ClosedPositionCard';
import { ClosedPositionsControls } from '@app/applications/Position/Ui/ClosedPositionsControls';
import { ClosedPositionsState } from '@app/applications/Position/Ui/PositionListState';
import { useClosedPositionsQuery } from '@app/applications/Position/Ui/useClosedPositionsQuery';
import { PagerBar } from '@app/applications/Shared/Ui/PagerBar';
import { SectionLabel } from '@app/applications/Shared/Ui/SectionLabel';
import { cn, Skeleton } from '@heroui/react';

/** Mobile "History" tab: the same headless query as the desktop table, rendered as cards with
 *  compact filter controls above them. */
export const MobileClosedPositionsList = () => {
  const closed = useClosedPositionsQuery();
  const now = Date.now();

  return (
    <div className="flex flex-col gap-3">
      <ClosedPositionsControls closed={closed} touch />

      <SectionLabel count={closed.total}>Closed</SectionLabel>

      <ClosedPositionsState
        closed={closed}
        skeleton={
          <div className="flex flex-col gap-2.5">
            {['a', 'b', 'c'].map((key) => (
              <Skeleton.Root key={key} className="h-[4.75rem] w-full rounded-2xl" />
            ))}
          </div>
        }
      >
        <div
          aria-busy={closed.stale}
          className={cn('flex flex-col gap-2.5 transition-opacity', closed.stale && 'opacity-60')}
        >
          {closed.rows.map((position) => (
            <ClosedPositionCard key={position.address} position={position} now={now} />
          ))}
        </div>
      </ClosedPositionsState>

      <PagerBar
        label="History pages"
        page={closed.page}
        pages={closed.pages}
        onPageChange={closed.setPage}
      />
    </div>
  );
};
