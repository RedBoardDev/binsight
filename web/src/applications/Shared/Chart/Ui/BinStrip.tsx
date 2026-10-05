import { type BinChartSource, binBars } from '@app/applications/Shared/Chart/Domain/binBars';
import { useId } from 'react';

const BIN_STRIP_HEIGHT_PX = 20;
const BIN_BAR_GAP_UNITS = 0.35;

interface BinStripProps {
  readonly chart: BinChartSource;
  readonly height?: number;
  readonly className?: string;
  readonly emphasis?: 'quiet' | 'normal';
}

export const BinStrip = ({
  chart,
  height = BIN_STRIP_HEIGHT_PX,
  className,
  emphasis = 'quiet',
}: BinStripProps) => {
  const geometry = binBars(chart);
  const gradientId = useId();
  const isOut = geometry.range !== 'in_range';
  if (!Number.isFinite(height) || height <= 0)
    throw new RangeError('A bin strip needs a positive height');
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox={`0 0 100 ${height}`}
      preserveAspectRatio="none"
      className={`block w-full ${className ?? ''}`}
      style={{ height }}
    >
      <defs>
        {/* Equal halves identify both token sides; their widths never encode monetary proportions. */}
        <linearGradient id={gradientId}>
          <stop offset="50%" stopColor="var(--bin-y)" />
          <stop offset="50%" stopColor="var(--bin-x)" />
        </linearGradient>
      </defs>
      <line
        x1={0}
        x2={100}
        y1={height}
        y2={height}
        stroke="var(--border)"
        vectorEffect="non-scaling-stroke"
      />
      {geometry.bars.map((bar) => (
        <rect
          key={bar.firstBinId}
          x={bar.leftRatio * 100}
          y={height * (1 - bar.heightRatio)}
          width={Math.max(0, bar.widthRatio * 100 - BIN_BAR_GAP_UNITS)}
          height={height * bar.heightRatio}
          rx={0.5}
          fill={
            isOut && emphasis === 'quiet'
              ? 'var(--warning)'
              : bar.side === 'mixed'
                ? `url(#${gradientId})`
                : `var(--bin-${bar.side === 'base' ? 'x' : 'y'})`
          }
          opacity={
            isOut
              ? emphasis === 'quiet'
                ? 0.35
                : 0.4
              : bar.isActive
                ? 1
                : emphasis === 'normal'
                  ? 0.6
                  : bar.side === 'quote'
                    ? 0.38
                    : 0.4
          }
        />
      ))}
      {geometry.markerRatio !== null && (
        <line
          x1={geometry.markerRatio * 100}
          x2={geometry.markerRatio * 100}
          y1={0}
          y2={height}
          stroke={isOut ? 'var(--warning)' : 'var(--foreground)'}
          vectorEffect="non-scaling-stroke"
        />
      )}
    </svg>
  );
};
