import { FigureAmount } from '@app/applications/Shared/Figure/Ui/FigureAmount';
import type { ApiSchema } from '@app/lib/api/apiSchema';
import { Popover } from '@heroui/react';
import { useLingui } from '@lingui/react/macro';
import { ChevronDown } from 'lucide-react';
import { Button } from 'react-aria-components';
import { NetWorthBreakdown } from './NetWorthFigure/NetWorthBreakdown';

interface NetWorthFigureProps {
  readonly netWorth: ApiSchema<'Overview'>['net_worth'];
  readonly layout: 'stocks' | 'compact';
}

export const NetWorthFigure = ({ netWorth, layout }: NetWorthFigureProps) => {
  const { t } = useLingui();
  const isStocks = layout === 'stocks';
  return (
    <div className={isStocks ? 'flex flex-col' : 'flex min-w-0 flex-col gap-1'}>
      <div
        className={
          isStocks
            ? 'grid min-h-10 grid-cols-[minmax(0,1fr)_auto_4rem] items-center gap-x-2 border-b border-border-subtle'
            : 'flex min-w-0 flex-col items-start gap-1'
        }
      >
        <Popover>
          <Button
            aria-label={t`Show net worth breakdown`}
            className={`figure-reasons-trigger inline-flex min-w-0 max-w-full w-fit items-center gap-1 rounded-sm outline-none data-[focus-visible]:ring-2 data-[focus-visible]:ring-focus ${isStocks ? 'text-meta text-muted' : 'caps-label'}`}
          >
            <span className="truncate">{t`Net worth`}</span>
            <ChevronDown aria-hidden strokeWidth={1.75} className="size-3 shrink-0" />
          </Button>
          <Popover.Content>
            <Popover.Dialog aria-label={t`Net worth breakdown`} className="px-4 py-3">
              <NetWorthBreakdown netWorth={netWorth} />
            </Popover.Dialog>
          </Popover.Content>
        </Popover>
        <span className={isStocks ? 'text-body font-semibold' : 'text-section'}>
          <FigureAmount
            figure={netWorth.total}
            placement="key"
            signing="negative-only"
            layout={isStocks ? 'column' : 'inline'}
          />
        </span>
        {isStocks && <span aria-hidden />}
      </div>
      <div
        className={`flex flex-wrap items-baseline gap-x-2 gap-y-1 text-small text-muted ${isStocks ? 'min-h-10 justify-end border-b border-border-subtle pr-18' : ''}`}
      >
        <span>
          {t`LP`} <FigureAmount figure={netWorth.lp} placement="body" signing="negative-only" />
        </span>
        <span aria-hidden>·</span>
        <span>
          {t`idle`} <FigureAmount figure={netWorth.idle} placement="body" signing="negative-only" />
        </span>
      </div>
    </div>
  );
};
