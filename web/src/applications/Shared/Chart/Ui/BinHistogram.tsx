import { type BinChartSource, binBars } from '@app/applications/Shared/Chart/Domain/binBars';
import { BinStrip } from '@app/applications/Shared/Chart/Ui/BinStrip';
import { useElementWidth } from '@app/applications/Shared/Chart/Ui/useElementWidth';
import { useScrubIndex } from '@app/applications/Shared/Chart/Ui/useScrubIndex';
import { useLingui } from '@lingui/react/macro';
import { type ReactNode, useId, useMemo } from 'react';

const BIN_HISTOGRAM_HEIGHT_PX = 72;

interface BinHistogramProps {
  readonly chart: BinChartSource;
  readonly label: string;
  readonly summary: string;
  readonly lowerLabel: string;
  readonly upperLabel: string;
  readonly rangeLabel: string;
  readonly activeIndex: number | null;
  readonly onScrub: (index: number | null) => void;
  readonly renderGroup: (sourceIndices: readonly number[]) => ReactNode;
  readonly describeGroup: (sourceIndices: readonly number[]) => string;
  readonly height?: number;
}

export const BinHistogram = ({
  chart,
  label,
  summary,
  lowerLabel,
  upperLabel,
  rangeLabel,
  activeIndex,
  onScrub,
  renderGroup,
  describeGroup,
  height = BIN_HISTOGRAM_HEIGHT_PX,
}: BinHistogramProps) => {
  const { t } = useLingui();
  const descriptionId = useId();
  const { ref, width } = useElementWidth();
  const geometry = useMemo(() => binBars(chart), [chart]);
  const positions = geometry.bars.map((bar) => (bar.leftRatio + bar.widthRatio / 2) * width);
  const selectedIndex =
    activeIndex !== null &&
    Number.isInteger(activeIndex) &&
    activeIndex >= 0 &&
    activeIndex < geometry.bars.length
      ? activeIndex
      : null;
  const selected = selectedIndex === null ? undefined : geometry.bars[selectedIndex];
  const announced = selected ?? geometry.bars.at(-1);
  const events = useScrubIndex({ positions, width, activeIndex: selectedIndex, onScrub });
  return (
    <figure aria-label={label} className="m-0">
      <figcaption className="min-h-11 text-small text-muted">
        {selected === undefined ? summary : renderGroup(selected.sourceIndices)}
      </figcaption>
      <div ref={ref} className="relative" style={{ height }}>
        <div role="img" aria-label={summary}>
          <BinStrip chart={chart} height={height} emphasis="normal" />
        </div>
        {selected !== undefined && (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-y-0 border-x border-accent"
            style={{ left: `${selected.leftRatio * 100}%`, width: `${selected.widthRatio * 100}%` }}
          />
        )}
        <div
          role="slider"
          aria-label={label}
          aria-describedby={descriptionId}
          aria-orientation="horizontal"
          aria-valuemin={0}
          aria-valuemax={Math.max(0, geometry.bars.length - 1)}
          aria-valuenow={selectedIndex ?? Math.max(0, geometry.bars.length - 1)}
          aria-valuetext={
            announced === undefined ? summary : describeGroup(announced.sourceIndices)
          }
          aria-disabled={geometry.bars.length === 0}
          tabIndex={geometry.bars.length === 0 ? -1 : 0}
          className="absolute inset-0 cursor-crosshair touch-pan-y"
          {...events}
        />
      </div>
      <div className="num mt-2 flex items-center justify-between gap-2 text-micro text-muted">
        <span>{lowerLabel}</span>
        <span>{rangeLabel}</span>
        <span>{upperLabel}</span>
      </div>
      <p id={descriptionId} className="sr-only">
        {t`Use the arrow keys to explore the chart. Home and End select the first and last readings.`}
      </p>
      <div className="sr-only">
        <table>
          <caption>{label}</caption>
          <thead>
            <tr>
              <th scope="col">{t`Chart readings`}</th>
            </tr>
          </thead>
          <tbody>
            {geometry.bars.map((bar) => (
              <tr key={bar.firstBinId}>
                <td>{describeGroup(bar.sourceIndices)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </figure>
  );
};
