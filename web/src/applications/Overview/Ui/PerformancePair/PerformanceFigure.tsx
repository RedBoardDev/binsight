import type { Figure, PercentFigure } from '@app/applications/Shared/Figure/Domain/figure';
import { FigureAmount } from '@app/applications/Shared/Figure/Ui/FigureAmount';
import { PercentValue } from '@app/applications/Shared/Figure/Ui/PercentValue';
import type { ReactNode } from 'react';

interface PerformanceFigureProps {
  readonly label: string;
  readonly amount: Figure;
  readonly percent: PercentFigure;
  readonly layout: 'stocks' | 'compact';
  readonly children: ReactNode;
}

export const PerformanceFigure = ({
  label,
  amount,
  percent,
  layout,
  children,
}: PerformanceFigureProps) => {
  const isStocks = layout === 'stocks';
  return (
    <div
      className={
        isStocks ? 'flex flex-col border-b border-border-subtle' : 'flex min-w-0 flex-col gap-1'
      }
    >
      <div
        className={
          isStocks
            ? 'grid min-h-10 grid-cols-[minmax(0,1fr)_auto_4rem] items-center gap-x-2'
            : 'flex min-w-0 flex-col items-start gap-1'
        }
      >
        <span className={isStocks ? 'text-meta text-muted' : 'caps-label'}>{label}</span>
        <span className={isStocks ? 'text-body font-semibold' : 'text-section'}>
          <FigureAmount
            figure={amount}
            placement="key"
            signing="always"
            layout={isStocks ? 'column' : 'inline'}
          />
        </span>
        <span className={`text-small text-muted ${isStocks ? 'justify-self-end' : ''}`}>
          <PercentValue figure={percent} placement="cell" signing="always" tone="neutral" />
        </span>
      </div>
      <div className={`empty:hidden text-small text-muted ${isStocks ? 'pb-2' : ''}`}>
        {children}
      </div>
    </div>
  );
};
