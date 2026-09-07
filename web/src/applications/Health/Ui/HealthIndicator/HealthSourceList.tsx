'use client';

import { healthDotClass, SOURCE_LABEL } from '@app/applications/Health/Domain/healthStatus';
import { fmtRelative } from '@app/applications/Shared/Domain/formatters';
import type { Health } from '@binsight/shared';
import { cn } from '@heroui/react';

interface HealthSourceListProps {
  health: Health;
}

/** The health detail body — one row per upstream source plus the engine footer. Rendered in both the
 *  hover tooltip and the pinned popover, so the two can never say different things. */
export const HealthSourceList = ({ health }: HealthSourceListProps) => {
  const now = Date.now();

  return (
    // break-normal: the tooltip surface sets `break-all`, which would shred these labels.
    <div className="flex w-64 flex-col gap-0.5 break-normal">
      {health.sources.length === 0 && (
        <p className="px-2 py-1.5 text-faint text-xs">No source data yet.</p>
      )}
      {health.sources.map((source) => (
        <div className="flex items-center justify-between gap-3 px-2 py-1.5" key={source.name}>
          <span className="flex min-w-0 items-center gap-2">
            <span className={cn('size-2 shrink-0 rounded-full', healthDotClass[source.status])} />
            <span className="truncate font-medium text-foreground text-sm capitalize">
              {source.name}
            </span>
            <span className="text-faint text-xs">{SOURCE_LABEL[source.status]}</span>
          </span>
          <span className="tabular shrink-0 text-faint text-xs">
            {source.detail ?? fmtRelative(source.lastOkAt, now)}
          </span>
        </div>
      ))}
      <div className="tabular mt-1 border-separator border-t px-2 pt-2 text-faint text-xs">
        {health.effectiveRps.toFixed(1)} rps · up {Math.floor(health.uptimeSeconds / 3600)}h
      </div>
    </div>
  );
};
