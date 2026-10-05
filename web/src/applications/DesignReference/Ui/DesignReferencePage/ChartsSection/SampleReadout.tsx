import { CHART_SAMPLES } from '@app/applications/DesignReference/Ui/DesignReferencePage/chartSamples';
import { FigureAmount } from '@app/applications/Shared/Figure/Ui/FigureAmount';
import { PercentValue } from '@app/applications/Shared/Figure/Ui/PercentValue';
import { useDateFormatters } from '@app/applications/Shared/Time/Ui/useDateFormatters';
import { useLingui } from '@lingui/react/macro';

interface SampleReadoutProps {
  readonly index: number;
}

export const SampleReadout = ({ index }: SampleReadoutProps) => {
  const { t } = useLingui();
  const { formatShortDate } = useDateFormatters();
  const point = CHART_SAMPLES[index];
  if (point === undefined) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-small">
      <span className="text-muted">{formatShortDate(point.start)}</span>
      <div>
        <span className="text-muted">{t`Profit`} </span>
        <FigureAmount figure={point.bar} placement="body" signing="always" />
        <div className="text-muted">
          {t`vs net worth`}{' '}
          <PercentValue
            figure={point.bar_share_of_net_worth}
            placement="cell"
            signing="always"
            tone="neutral"
          />
        </div>
      </div>
      <div>
        <span className="text-muted">{t`Cumulative`} </span>
        <FigureAmount figure={point.line} placement="body" signing="always" />
        <div className="text-muted">
          {t`vs net worth`}{' '}
          <PercentValue
            figure={point.line_share_of_net_worth}
            placement="cell"
            signing="always"
            tone="neutral"
          />
        </div>
      </div>
    </div>
  );
};
