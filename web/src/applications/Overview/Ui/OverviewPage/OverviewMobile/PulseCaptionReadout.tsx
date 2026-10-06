import { usePulseReadoutFigures } from '@app/applications/Overview/Ui/OverviewPage/usePulseReadoutFigures';
import { useDateFormatters } from '@app/applications/Shared/Time/Ui/useDateFormatters';
import type { ApiSchema } from '@app/lib/api/apiSchema';
import { useLingui } from '@lingui/react/macro';
import type { ReactNode } from 'react';

interface PulseCaptionReadoutProps {
  readonly point: ApiSchema<'SeriesPoint'>;
  readonly timeZone: string;
}

// The phone's reading, in place of the legend and the period pills: the day, its profit and its
// share of net worth on the first line; the cumulative profit and its share on the second, under
// the profit. Each line may wrap, never clip: a figure is never cut short.
export const PulseCaptionReadout = ({ point, timeZone }: PulseCaptionReadoutProps) => {
  const { t } = useLingui();
  const { formatDay } = useDateFormatters(timeZone);
  const figures = usePulseReadoutFigures(point, 'static');
  return (
    <div className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-2 text-small">
      <span className="whitespace-nowrap font-medium text-muted">{formatDay(point.start)}</span>
      <ReadingLine swatch="h-2.5 w-0.75 rounded-xs bg-faint" label={t`Daily`}>
        {figures.profit}
        <span className="text-faint">{figures.profitShare}</span>
      </ReadingLine>
      <span />
      <ReadingLine swatch="h-0.5 w-2.5 bg-accent" label={t`Cumulative`}>
        {figures.cumulative}
        <span className="text-faint">{figures.cumulativeShare}</span>
      </ReadingLine>
    </div>
  );
};

interface ReadingLineProps {
  readonly swatch: string;
  readonly label: string;
  readonly children: ReactNode;
}

const ReadingLine = ({ swatch, label, children }: ReadingLineProps) => (
  <span className="flex min-w-0 flex-wrap items-baseline gap-x-1.5">
    <span className="inline-flex items-baseline gap-1.5 whitespace-nowrap">
      <span aria-hidden className={`self-center ${swatch}`} />
      <span className="text-faint">{label}</span>
    </span>
    {children}
  </span>
);
