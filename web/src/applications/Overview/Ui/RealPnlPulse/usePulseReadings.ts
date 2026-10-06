import type { Figure, PercentFigure } from '@app/applications/Shared/Figure/Domain/figure';
import { describeReason, speakFigure } from '@app/applications/Shared/Figure/Ui/figureSpeech';
import { useFigureFormatter } from '@app/applications/Shared/Figure/Ui/useFigureFormatter';
import { useDateFormatters } from '@app/applications/Shared/Time/Ui/useDateFormatters';
import type { ApiSchema } from '@app/lib/api/apiSchema';
import { useLingui } from '@lingui/react/macro';

export const usePulseReadings = (
  series: ApiSchema<'StatsSeries'> | undefined,
): {
  readonly describePoint: (index: number) => string;
  readonly summary: string;
} => {
  const { i18n, t } = useLingui();
  const format = useFigureFormatter();
  const { formatShortDate } = useDateFormatters(series?.window.timezone);
  const quality = (figure: Figure | PercentFigure | undefined | null) =>
    figure === undefined || figure === null || figure.exactness === 'complete'
      ? ''
      : figure.reasons.map((reason) => describeReason(i18n, reason)).join(' ');
  const amount = (figure: Figure | undefined | null) =>
    [
      speakFigure(i18n, {
        formatted:
          figure === undefined || figure === null || figure.exactness === 'unavailable'
            ? null
            : format.amount(figure.value, 'body', 'always'),
        unit:
          figure === undefined || figure === null || figure.exactness === 'unavailable'
            ? null
            : figure.value.unit,
        exactness: figure?.exactness ?? 'unavailable',
        isHidden: format.areAmountsHidden,
      }),
      quality(figure),
    ]
      .filter(Boolean)
      .join('. ');
  const percent = (figure: PercentFigure | undefined | null) =>
    [
      speakFigure(i18n, {
        formatted:
          figure === undefined || figure === null || figure.exactness === 'unavailable'
            ? null
            : format.percent(figure.value, 'cell', 'always'),
        unit: null,
        exactness: figure?.exactness ?? 'unavailable',
        isHidden: false,
      }),
      quality(figure),
    ]
      .filter(Boolean)
      .join('. ');
  return {
    summary: `${t`Real PnL`}: ${amount(series?.header.value)}`,
    describePoint: (index) => {
      const point = series?.points[index];
      return point === undefined
        ? t`No chart values`
        : `${formatShortDate(point.start)}; ${t`Profit`}: ${amount(point.bar)}; ${t`vs net worth`}: ${percent(point.bar_share_of_net_worth)}; ${t`Cumulative`}: ${amount(point.line)}; ${t`vs net worth`}: ${percent(point.line_share_of_net_worth)}`;
    },
  };
};
