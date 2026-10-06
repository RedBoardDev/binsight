import { LineSeriesChart } from '@app/applications/Shared/Chart/Ui/LineSeriesChart';
import { StackedBarChart } from '@app/applications/Shared/Chart/Ui/StackedBarChart';
import { numberFormat } from '@app/applications/Shared/Figure/Domain/numberFormat';
import { FigureAmount } from '@app/applications/Shared/Figure/Ui/FigureAmount';
import { speakFigure } from '@app/applications/Shared/Figure/Ui/figureSpeech';
import { PercentValue } from '@app/applications/Shared/Figure/Ui/PercentValue';
import { useFigureFormatter } from '@app/applications/Shared/Figure/Ui/useFigureFormatter';
import { dateTimeFormat } from '@app/applications/Shared/Time/Domain/timeFormat';
import { useDateFormatters } from '@app/applications/Shared/Time/Ui/useDateFormatters';
import { useLingui } from '@lingui/react/macro';
import { useState } from 'react';
import {
  CREDIT_CYCLE_SAMPLE,
  CREDIT_SAMPLES,
  NET_WORTH_CHANGE,
  NET_WORTH_SAMPLES,
} from './seriesSamples';

export const SeriesSamples = () => {
  const [lineIndex, setLineIndex] = useState<number | null>(null);
  const [creditIndex, setCreditIndex] = useState<number | null>(null);
  const [stackIndex, setStackIndex] = useState<number | null>(null);
  const format = useFigureFormatter();
  const { i18n } = useLingui();
  const { formatShortDate } = useDateFormatters();
  const creditDate = (index: number) => {
    const day = CREDIT_SAMPLES[index]?.day;
    return day === undefined
      ? ''
      : dateTimeFormat(i18n.locale, { timeZone: 'UTC', month: 'short', day: 'numeric' }).format(
          new Date(`${day}T00:00:00Z`),
        );
  };
  const creditReading = (index: number) => {
    const day = CREDIT_SAMPLES[index];
    return day === undefined
      ? ''
      : `${creditDate(index)}: ${numberFormat(i18n.locale, {}).format(day.used)} credits; daily budget 650`;
  };
  const lineReading = (index: number) => {
    const point = NET_WORTH_SAMPLES[index];
    if (point === undefined) return '';
    return `${formatShortDate(point.start)}; Net worth: ${speakFigure(i18n, {
      formatted:
        point.line.exactness === 'unavailable'
          ? null
          : format.amount(point.line.value, 'body', 'negative-only'),
      unit: 'sol',
      exactness: point.line.exactness,
      isHidden: format.areAmountsHidden,
    })}; Period change: +10%`;
  };
  return (
    <div className="grid w-full gap-8">
      <LineSeriesChart
        points={NET_WORTH_SAMPLES}
        label="Net worth sample"
        summary="Server net worth readings with estimated and unavailable values"
        activeIndex={lineIndex}
        onScrub={setLineIndex}
        describePoint={lineReading}
        renderReadout={(index) => {
          const point = NET_WORTH_SAMPLES[index];
          return point === undefined ? null : (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-small">
              <span className="text-muted">{formatShortDate(point.start)}</span>
              <span>
                Net worth{' '}
                <FigureAmount figure={point.line} placement="body" signing="negative-only" />
              </span>
              <span>
                Period change{' '}
                <PercentValue
                  figure={NET_WORTH_CHANGE}
                  placement="cell"
                  signing="always"
                  tone="neutral"
                />
              </span>
            </div>
          );
        }}
      />
      <StackedBarChart
        days={CREDIT_SAMPLES}
        cycle={CREDIT_CYCLE_SAMPLE}
        dailyBudget={650}
        todayIndex={9}
        label="Billing cycle credits sample"
        summary="Daily server credits from October 17 to November 17, with November 2 highlighted"
        activeIndex={creditIndex}
        onScrub={setCreditIndex}
        formatDay={creditDate}
        describePoint={creditReading}
        renderReadout={(index) => <span className="num text-body">{creditReading(index)}</span>}
      />
      <StackedBarChart
        days={CREDIT_SAMPLES}
        cycle={CREDIT_CYCLE_SAMPLE}
        dailyBudget={650}
        todayIndex={9}
        variant="stacked"
        label="Generic credit stacks sample"
        summary="The same server credit days drawn as generic stacks"
        activeIndex={stackIndex}
        onScrub={setStackIndex}
        formatDay={creditDate}
        describePoint={creditReading}
        renderReadout={(index) => <span className="num text-body">{creditReading(index)}</span>}
      />
    </div>
  );
};
