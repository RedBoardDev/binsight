import { FigureAmount } from '@app/applications/Shared/Figure/Ui/FigureAmount';
import { PercentValue } from '@app/applications/Shared/Figure/Ui/PercentValue';
import { useDateFormatters } from '@app/applications/Shared/Time/Ui/useDateFormatters';
import type { ApiSchema } from '@app/lib/api/apiSchema';
import { useLingui } from '@lingui/react/macro';

interface PulseReadoutProps {
  readonly point: ApiSchema<'SeriesPoint'>;
  readonly timeZone: string;
  readonly layout: 'desktop' | 'mobile';
}

export const PulseReadout = ({ point, timeZone, layout }: PulseReadoutProps) => {
  const { t } = useLingui();
  const { formatShortDate } = useDateFormatters(timeZone);
  const unavailable = (
    <span>
      <span aria-hidden>—</span>
      <span className="sr-only">{t`Not available`}</span>
    </span>
  );
  return (
    <div className="w-full text-small">
      <p
        className={
          layout === 'mobile' ? 'mb-1 flex h-11 items-center text-muted' : 'mb-1 text-muted'
        }
      >
        {formatShortDate(point.start)}
      </p>
      <div className={layout === 'desktop' ? 'flex flex-col gap-2' : 'grid grid-cols-2 gap-x-4'}>
        <div>
          <div
            className={
              layout === 'desktop'
                ? 'flex items-baseline justify-between gap-2'
                : 'flex min-h-11 items-center gap-1'
            }
          >
            <span className="min-w-0 truncate text-muted">{t`Profit`} </span>
            {point.bar === undefined || point.bar === null ? (
              unavailable
            ) : (
              <FigureAmount
                figure={point.bar}
                placement="body"
                signing="always"
                reasonDisplay={layout === 'desktop' ? 'static' : 'popover'}
              />
            )}
          </div>
          <p
            className={
              layout === 'desktop'
                ? 'flex justify-between gap-2 text-muted'
                : 'flex min-h-11 items-center gap-1 text-muted'
            }
          >
            <span className="min-w-0 truncate">{t`vs net worth`}</span>{' '}
            {point.bar_share_of_net_worth === undefined || point.bar_share_of_net_worth === null ? (
              unavailable
            ) : (
              <PercentValue
                figure={point.bar_share_of_net_worth}
                placement="cell"
                signing="always"
                tone="neutral"
                reasonDisplay={layout === 'desktop' ? 'static' : 'popover'}
              />
            )}
          </p>
        </div>
        <div>
          <div
            className={
              layout === 'desktop'
                ? 'flex items-baseline justify-between gap-2'
                : 'flex min-h-11 items-center gap-1'
            }
          >
            <span className="min-w-0 truncate text-muted">{t`Cumulative`} </span>
            <FigureAmount
              figure={point.line}
              placement="body"
              signing="always"
              reasonDisplay={layout === 'desktop' ? 'static' : 'popover'}
            />
          </div>
          <p
            className={
              layout === 'desktop'
                ? 'flex justify-between gap-2 text-muted'
                : 'flex min-h-11 items-center gap-1 text-muted'
            }
          >
            <span className="min-w-0 truncate">{t`vs net worth`}</span>{' '}
            {point.line_share_of_net_worth === undefined ||
            point.line_share_of_net_worth === null ? (
              unavailable
            ) : (
              <PercentValue
                figure={point.line_share_of_net_worth}
                placement="cell"
                signing="always"
                tone="neutral"
                reasonDisplay={layout === 'desktop' ? 'static' : 'popover'}
              />
            )}
          </p>
        </div>
      </div>
    </div>
  );
};
