'use client';

import { usePortfolioFeed } from '@app/applications/Portfolio/Api/portfolioFeed.store';
import { forceRefresh } from '@app/applications/Shared/Api/refresh';
import { shortAddr } from '@app/applications/Shared/Domain/formatters';
import { useCopy } from '@app/applications/Shared/Ui/useCopy';
import { Button, cn, Tooltip } from '@heroui/react';
import { Check, Copy, RefreshCw } from 'lucide-react';
import { useState } from 'react';

/**
 * Sits to the right of the tab row: the scoped wallet address pill plus a force-refresh. No "updated"
 * timestamp — the socket stream is real-time, so a relative time would only be noise.
 */
export const ScopeActions = () => {
  const scope = usePortfolioFeed((s) => s.scope);
  const { copied, copy } = useCopy();
  const [spinning, setSpinning] = useState(false);

  const refresh = async () => {
    if (spinning) return;
    setSpinning(true);
    try {
      await forceRefresh();
    } catch {
      /* surfaced by the health indicator — never wedge the button */
    } finally {
      setSpinning(false);
    }
  };

  return (
    <div className="flex items-center gap-2 pb-1.5">
      {scope !== 'all' && (
        <Tooltip.Root delay={400}>
          <Tooltip.Trigger>
            <Button
              variant="secondary"
              size="sm"
              className="tabular"
              onPress={() => void copy(scope)}
            >
              {shortAddr(scope, 5, 5)}
              {copied ? <Check size={14} className="text-success" /> : <Copy size={14} />}
            </Button>
          </Tooltip.Trigger>
          <Tooltip.Content>Copy wallet address</Tooltip.Content>
        </Tooltip.Root>
      )}
      <Tooltip.Root delay={400}>
        <Tooltip.Trigger>
          <Button
            variant="ghost"
            isIconOnly
            size="sm"
            aria-label="Force refresh"
            onPress={() => void refresh()}
          >
            <RefreshCw size={14} className={cn(spinning && 'animate-spin')} />
          </Button>
        </Tooltip.Trigger>
        <Tooltip.Content>Force refresh</Tooltip.Content>
      </Tooltip.Root>
    </div>
  );
};
