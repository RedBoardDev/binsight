import type { PriceChartSeries } from '@app/applications/Shared/Chart/Domain/Candle/priceCandles';
import { PriceValue } from '@app/applications/Shared/Figure/Ui/PriceValue';
import { useFigureFormatter } from '@app/applications/Shared/Figure/Ui/useFigureFormatter';
import { useDateFormatters } from '@app/applications/Shared/Time/Ui/useDateFormatters';
import { msg } from '@lingui/core/macro';
import { useLingui } from '@lingui/react/macro';
import { type ReactNode, useCallback, useMemo } from 'react';

const FIELD_MESSAGES = {
  open: msg`Open`,
  high: msg`High`,
  low: msg`Low`,
  close: msg`Closing price`,
};
const FIELDS = ['open', 'high', 'low', 'close'] as const;

interface CandleReadings {
  readonly describePoint: (index: number) => string;
  readonly renderReadout: (index: number) => ReactNode;
}

export const useCandleReadings = (
  source: PriceChartSeries,
  describeStatus?: (index: number) => string,
): CandleReadings => {
  const { i18n } = useLingui();
  const { formatDateTime } = useDateFormatters();
  const format = useFigureFormatter();
  const { candles, quoteSymbol } = source;
  const descriptions = useMemo(
    () =>
      candles.map((candle, index) =>
        [
          formatDateTime(candle.start),
          ...FIELDS.map(
            (field) =>
              `${i18n._(FIELD_MESSAGES[field])}: ${format.price({ amount: candle[field], quote: quoteSymbol }).text}`,
          ),
          quoteSymbol.toUpperCase(),
          describeStatus?.(index),
        ]
          .filter(Boolean)
          .join('; '),
      ),
    [candles, quoteSymbol, formatDateTime, format, i18n, describeStatus],
  );
  const describePoint = useCallback(
    (index: number): string => descriptions[index] ?? '',
    [descriptions],
  );
  const renderReadout = (index: number): ReactNode => {
    const candle = source.candles[index];
    return candle === undefined ? null : (
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-small">
        <span className="text-muted">{formatDateTime(candle.start)}</span>
        {FIELDS.map((field) => (
          <span key={field}>
            <span className="text-muted">{i18n._(FIELD_MESSAGES[field])} </span>
            <PriceValue price={{ amount: candle[field], quote: source.quoteSymbol }} />
          </span>
        ))}
        <span className="text-muted">{source.quoteSymbol.toUpperCase()}</span>
        {describeStatus !== undefined && (
          <span className="text-muted">{describeStatus(index)}</span>
        )}
      </div>
    );
  };
  return { describePoint, renderReadout };
};
