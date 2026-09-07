'use client';

import { useSolUsd } from '@app/applications/Shared/Api/useSolUsd.api';
import { SolMark } from '@app/applications/Shared/Ui/SolMark';
import { usePrefs } from '@app/core/stores/prefsStore';
import { useUi } from '@app/core/stores/uiStore';
import { Button, cn, Tooltip } from '@heroui/react';
import { Eye, EyeOff, Settings } from 'lucide-react';

interface DisplayControlsProps {
  /** Phones get a 36px target; the desktop bar stays compact at 32px. */
  size?: 'sm' | 'md';
}

/**
 * The grouped header toolbar — currency, privacy, settings. One consistently-sized icon set rather
 * than a row of mismatched buttons, shared verbatim by the desktop and mobile bars.
 */
export const DisplayControls = ({ size = 'sm' }: DisplayControlsProps) => {
  const setSettingsOpen = useUi((s) => s.setSettingsOpen);
  const hideAmounts = usePrefs((s) => s.hideAmounts);
  const toggleHideAmounts = usePrefs((s) => s.toggleHideAmounts);
  const currency = usePrefs((s) => s.currency);
  const setCurrency = usePrefs((s) => s.setCurrency);
  const solUsd = useSolUsd();

  const other = currency === 'SOL' ? 'USD' : 'SOL';
  // Phones get the 44px minimum touch target; the desktop bar stays compact.
  const box = size === 'md' ? 'size-11' : 'size-8';
  const rateLabel =
    solUsd != null
      ? `1 SOL = $${solUsd.toLocaleString('en-US', { maximumFractionDigits: 2 })} · show in ${other}`
      : `Show amounts in ${other}`;

  return (
    <div className="flex items-center gap-0.5 rounded-lg bg-surface-secondary/50 p-0.5 ring-1 ring-border ring-inset">
      <Tooltip.Root delay={400}>
        <Tooltip.Trigger>
          <Button
            variant="ghost"
            isIconOnly
            aria-label={`Display amounts in ${other}`}
            className={cn(box, 'text-muted hover:text-foreground')}
            onPress={() => setCurrency(other)}
          >
            {currency === 'SOL' ? (
              <SolMark size={15} />
            ) : (
              <span className="font-semibold text-[15px] leading-none">$</span>
            )}
          </Button>
        </Tooltip.Trigger>
        <Tooltip.Content>{rateLabel}</Tooltip.Content>
      </Tooltip.Root>

      <Tooltip.Root delay={400}>
        <Tooltip.Trigger>
          <Button
            variant="ghost"
            isIconOnly
            aria-label={hideAmounts ? 'Show amounts' : 'Hide amounts'}
            aria-pressed={hideAmounts}
            className={cn(box, hideAmounts ? 'text-accent' : 'text-muted hover:text-foreground')}
            onPress={toggleHideAmounts}
          >
            {hideAmounts ? <EyeOff size={16} /> : <Eye size={16} />}
          </Button>
        </Tooltip.Trigger>
        <Tooltip.Content>
          {hideAmounts ? 'Show amounts' : 'Hide amounts (for sharing)'}
        </Tooltip.Content>
      </Tooltip.Root>

      <Tooltip.Root delay={400}>
        <Tooltip.Trigger>
          <Button
            variant="ghost"
            isIconOnly
            aria-label="Settings"
            className={cn(box, 'text-muted hover:text-foreground')}
            onPress={() => setSettingsOpen(true)}
          >
            <Settings size={16} />
          </Button>
        </Tooltip.Trigger>
        <Tooltip.Content>Settings</Tooltip.Content>
      </Tooltip.Root>
    </div>
  );
};
