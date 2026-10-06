import type { Figure, PercentFigure } from '@app/applications/Shared/Figure/Domain/figure';
import { speakFigure } from '@app/applications/Shared/Figure/Ui/figureSpeech';
import { useFigureFormatter } from '@app/applications/Shared/Figure/Ui/useFigureFormatter';
import { useDateFormatters } from '@app/applications/Shared/Time/Ui/useDateFormatters';
import { useLingui } from '@lingui/react/macro';
import { CHART_SAMPLES } from './pulseSamples';

export const usePulseSampleReadings = (): ((index: number) => string) => {
  const { t, i18n } = useLingui();
  const format = useFigureFormatter();
  const { formatShortDate } = useDateFormatters();
  const amount = (figure: Figure) =>
    speakFigure(i18n, {
      formatted:
        figure.exactness === 'unavailable' ? null : format.amount(figure.value, 'body', 'always'),
      unit: figure.exactness === 'unavailable' ? null : figure.value.unit,
      exactness: figure.exactness,
      isHidden: format.areAmountsHidden,
    });
  const percent = (figure: PercentFigure) =>
    speakFigure(i18n, {
      formatted:
        figure.exactness === 'unavailable' ? null : format.percent(figure.value, 'cell', 'always'),
      unit: null,
      exactness: figure.exactness,
      isHidden: false,
    });
  return (index) => {
    const point = CHART_SAMPLES[index];
    return point === undefined
      ? t`No chart values`
      : `${formatShortDate(point.start)}; ${t`Profit`}: ${amount(point.bar)}; ${t`vs net worth`}: ${percent(point.bar_share_of_net_worth)}; ${t`Cumulative`}: ${amount(point.line)}; ${t`vs net worth`}: ${percent(point.line_share_of_net_worth)}`;
  };
};
