import { usePulseReadoutFigures } from '@app/applications/Overview/Ui/RealPnlPulse/PulseReadoutFigures';
import { useDateFormatters } from '@app/applications/Shared/Time/Ui/useDateFormatters';
import type { ApiSchema } from '@app/lib/api/apiSchema';
import { useLingui } from '@lingui/react/macro';

interface PulseReadoutProps {
  readonly point: ApiSchema<'SeriesPoint'>;
  readonly timeZone: string;
}

// The desktop tooltip: the day with its weekday, then profit and cumulative, each followed by its
// share of net worth, indented under it.
export const PulseReadout = ({ point, timeZone }: PulseReadoutProps) => {
  const { t } = useLingui();
  const { formatDay } = useDateFormatters(timeZone);
  const figures = usePulseReadoutFigures(point, 'static');
  return (
    <div className="w-full text-small">
      <p className="mb-1 text-muted">{formatDay(point.start)}</p>
      <div className="flex flex-col gap-2">
        <div>
          <div className="flex items-baseline justify-between gap-2">
            <span className="min-w-0 truncate text-muted">{t`Profit`}</span>
            {figures.profit}
          </div>
          <p className="flex justify-between gap-2 ps-3 text-muted">
            <span className="min-w-0 truncate">{t`vs net worth`}</span>
            {figures.profitShare}
          </p>
        </div>
        <div>
          <div className="flex items-baseline justify-between gap-2">
            <span className="min-w-0 truncate text-muted">{t`Cumulative`}</span>
            {figures.cumulative}
          </div>
          <p className="flex justify-between gap-2 ps-3 text-muted">
            <span className="min-w-0 truncate">{t`vs net worth`}</span>
            {figures.cumulativeShare}
          </p>
        </div>
      </div>
    </div>
  );
};
