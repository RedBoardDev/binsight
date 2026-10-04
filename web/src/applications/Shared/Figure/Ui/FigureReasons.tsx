import type { FigureReason } from '@app/applications/Shared/Figure/Domain/figure';
import { describeReason } from '@app/applications/Shared/Figure/Ui/figureSpeech';
import { Popover } from '@heroui/react';
import { useLingui } from '@lingui/react/macro';
import type { ReactNode } from 'react';
import { Button } from 'react-aria-components';

interface FigureReasonsProps {
  label: string;
  title: string;
  reasons: readonly FigureReason[];
  children: ReactNode;
}

// Opens on a press, not a hover: a finger has no hover. Secondary text is muted, not faint: faint
// is too pale on the elevated tone.
export const FigureReasons = ({ label, title, reasons, children }: FigureReasonsProps) => {
  const { i18n } = useLingui();
  // Two reasons can read the same (a token unpriced in two wallets): each sentence is said once.
  const sentences = [...new Set(reasons.map((reason) => describeReason(i18n, reason)))];

  return (
    <Popover>
      <Button
        aria-label={label}
        className="figure-reasons-trigger cursor-help rounded-sm outline-none data-[focus-visible]:ring-2 data-[focus-visible]:ring-focus"
      >
        {children}
      </Button>
      <Popover.Content>
        <Popover.Dialog aria-label={title} className="flex flex-col gap-1 px-3 py-2">
          <span className="font-semibold">{title}</span>
          {sentences.map((sentence) => (
            <span key={sentence} className="text-muted">
              {sentence}
            </span>
          ))}
        </Popover.Dialog>
      </Popover.Content>
    </Popover>
  );
};
