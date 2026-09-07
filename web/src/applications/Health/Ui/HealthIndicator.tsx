'use client';

import {
  HEALTH_LABEL,
  healthDotClass,
  overallHealthStatus,
} from '@app/applications/Health/Domain/healthStatus';
import { HealthSourceList } from '@app/applications/Health/Ui/HealthIndicator/HealthSourceList';
import { usePortfolioFeed } from '@app/applications/Portfolio/Api/portfolioFeed.store';
import { Button, cn, Popover, Tooltip } from '@heroui/react';
import { useState } from 'react';

/** Live-feed status: a dot + label, with the per-source detail behind it. */
export const HealthIndicator = () => {
  const health = usePortfolioFeed((s) => s.health);
  const connected = usePortfolioFeed((s) => s.connected);
  const [pinned, setPinned] = useState(false);

  const status = overallHealthStatus(health, connected);
  const label = HEALTH_LABEL[status];
  const trigger = (
    <Button className="h-11 gap-2 md:h-8" size="sm" variant="ghost">
      <span
        className={cn(
          'size-2 shrink-0 rounded-full',
          healthDotClass[status],
          // Only a healthy feed breathes — a pulsing dot on a dead socket reads as activity.
          status === 'ok' && 'animate-pulse',
        )}
      />
      <span>{label}</span>
    </Button>
  );

  if (!health) return trigger;

  // The detail reveals on hover/focus as a tooltip AND pins open as a popover on press or Enter —
  // so it is reachable on touch and by keyboard, not hover-only. The popover closes itself on
  // Escape and on an outside pointer; the tooltip stands down while it is pinned so only one shows.
  return (
    <Popover.Root isOpen={pinned} onOpenChange={setPinned}>
      <Tooltip.Root isDisabled={pinned}>
        {trigger}
        <Tooltip.Content className="p-1">
          <HealthSourceList health={health} />
        </Tooltip.Content>
      </Tooltip.Root>
      <Popover.Content>
        <Popover.Dialog className="p-1" aria-label={`Service health: ${label}`}>
          <HealthSourceList health={health} />
        </Popover.Dialog>
      </Popover.Content>
    </Popover.Root>
  );
};
