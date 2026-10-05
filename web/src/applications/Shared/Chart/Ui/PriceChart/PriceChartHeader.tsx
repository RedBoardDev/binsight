import type { PriceChartProps } from '@app/applications/Shared/Chart/Ui/PriceChart';
import { TextPills } from '@app/applications/Shared/Control/Ui/TextPills';
import { PriceValue } from '@app/applications/Shared/Figure/Ui/PriceValue';
import { useLingui } from '@lingui/react/macro';

const TIMEFRAMES = [
  { id: '5m', label: '5m' },
  { id: '15m', label: '15m' },
  { id: '1h', label: '1h' },
  { id: '4h', label: '4h' },
  { id: '1d', label: '1D' },
] as const;

interface PriceChartHeaderProps {
  readonly source: PriceChartProps;
}

export const PriceChartHeader = ({ source }: PriceChartHeaderProps) => {
  const { t } = useLingui();
  return (
    <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
      <div className="flex items-baseline gap-2">
        <span className="text-section font-semibold">{t`Price`}</span>
        {source.closedAt === undefined && source.currentPrice !== undefined && (
          <span className="text-body">
            <PriceValue price={{ amount: source.currentPrice, quote: source.quoteSymbol }} />
          </span>
        )}
        <span className="text-small text-faint">{t`in ${source.quoteSymbol.toUpperCase()}`}</span>
      </div>
      {source.onTimeframeChange !== undefined && (
        <TextPills
          label={t`Price interval`}
          options={TIMEFRAMES}
          selected={source.timeframe}
          onChange={source.onTimeframeChange}
        />
      )}
    </div>
  );
};
