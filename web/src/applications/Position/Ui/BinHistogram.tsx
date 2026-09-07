import { fmtAmount } from '@app/applications/Shared/Domain/formatters';
import type { PositionBins } from '@binsight/shared';
import { Chip, cn } from '@heroui/react';

interface BinHistogramProps {
  data: PositionBins;
}

/**
 * Per-bin liquidity histogram. Bars below the current price are token-X (violet), bars at/above
 * are token-Y / SOL (cyan); a vertical marker + price label shows the live price — so the range is
 * read directly off the chart (no separate range bar needed).
 */
export const BinHistogram = ({ data }: BinHistogramProps) => {
  const values = data.bins.map((bin) => bin.amountY + bin.amountX * bin.price);
  const max = Math.max(1e-9, ...values);
  const first = data.bins.at(0);
  const last = data.bins.at(-1);

  const count = data.bins.length;
  const aboveIndex = data.bins.findIndex((bin) => bin.binId >= data.activeBinId);
  const fraction = aboveIndex < 0 ? 1 : aboveIndex / Math.max(1, count);
  const activePrice =
    data.bins.find((bin) => bin.binId === data.activeBinId)?.price ??
    (aboveIndex < 0 ? last?.price : first?.price);

  return (
    <div
      className="flex flex-col gap-2"
      role="img"
      aria-label={`Liquidity across ${count} price bins`}
    >
      <div className="relative flex h-36 items-end gap-px">
        {data.bins.map((bin, index) => {
          const height = Math.max(2, ((values[index] ?? 0) / max) * 100);
          const below = bin.binId < data.activeBinId;
          return (
            <div
              key={bin.binId}
              className={cn('flex-1 rounded-t-[2px]', below ? 'bg-bin-x' : 'bg-bin-y')}
              style={{ height: `${height}%` }}
              title={fmtAmount(bin.price)}
            />
          );
        })}

        <div
          className="pointer-events-none absolute inset-y-0 w-px bg-foreground/70"
          style={{ left: `${fraction * 100}%` }}
        />
        {activePrice != null && (
          <div
            className="-translate-x-1/2 pointer-events-none absolute top-0"
            style={{ left: `${Math.min(88, Math.max(12, fraction * 100))}%` }}
          >
            <Chip.Root size="sm" variant="soft" color="default" className="whitespace-nowrap">
              <Chip.Label>
                <span className="text-faint">Current </span>
                <span className="tabular text-foreground">{fmtAmount(activePrice)}</span>
              </Chip.Label>
            </Chip.Root>
          </div>
        )}
      </div>

      <div className="flex justify-between tabular text-faint text-xs">
        <span>{first ? fmtAmount(first.price) : '—'}</span>
        <span>{last ? fmtAmount(last.price) : '—'}</span>
      </div>
    </div>
  );
};
